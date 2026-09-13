import { randomUUID } from 'crypto';
import {
  BaseRelayDriver,
  CommPath,
  RelayCommProfile,
  RelayStatusSnapshotV2,
  Unsubscribe,
  UnifiedEvent,
  SourceProtocolV2,
  ProtocolCapabilities,
  PROTOCOL_CATALOGUE,
  DisturbanceFileRef,
  RetrievedDisturbanceFile,
  ProtectionFunctionCode,
} from '@simorgh/shared';

/**
 * IEC 61850 drivers: MMS (station bus), GOOSE (layer-2 multicast), Sampled Values, and MMS file
 * services for COMTRADE retrieval.
 *
 * ON THE NATIVE STACK
 * -------------------
 * A conformant IEC 61850 stack (MMS/ACSE/ISO presentation over TPKT, plus GOOSE/SV link-layer
 * encoding) is a large, certification-sensitive piece of software; the reference implementation in
 * the industry is the C library libiec61850. Re-implementing it in TypeScript would be both a very
 * large undertaking and, more importantly, the wrong engineering call — a protection-monitoring
 * platform should use a stack that has been through conformance testing, not a bespoke one.
 *
 * So these drivers are written against a narrow adapter interface (Iec61850Adapter). Bind the
 * native stack once, in one place, and every driver here works against real hardware. Without a
 * bound adapter the drivers run in simulator mode, which is what lets the whole platform be
 * demonstrated and tested before a substation is available.
 *
 * The adapter interface is READ-ONLY by construction: it exposes read, report-subscribe, file-list
 * and file-get. There is no write/control/operate method, so binding a native stack cannot
 * accidentally open a control path — the adapter simply has nowhere to put one.
 */

// ---------------------------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------------------------

export interface Iec61850DataValue {
  /** Full object reference, e.g. "IED1LD0/PTOC1.Str.general". */
  reference: string;
  value: number | boolean | string | null;
  /** IEC 61850 quality flags, already decoded. */
  quality?: { validity: 'good' | 'invalid' | 'questionable'; test?: boolean };
  /** The IED's own timestamp (t), which is what makes MMS reports timeline-grade. */
  timestamp?: Date;
}

export interface Iec61850ReportPayload {
  rcbReference: string;
  dataSetName: string;
  /** Report reason: dchg (data change), qchg (quality change), integrity, GI. */
  reason: string;
  values: Iec61850DataValue[];
  /** Sequence number — a gap means reports were lost, which is itself worth knowing. */
  sequenceNumber?: number;
}

export interface GoosePayload {
  goCbReference: string;
  dataSetName: string;
  /** Increments on every state change; a jump indicates a missed message. */
  stNum: number;
  /** Increments on each retransmission within a state. */
  sqNum: number;
  /** Configured time-to-live for the message, milliseconds. */
  timeAllowedToLive: number;
  values: Iec61850DataValue[];
  timestamp: Date;
  /** Set when the publisher marks the dataset as test/simulated — must never raise a real alarm. */
  test: boolean;
}

export interface SampledValuePayload {
  svIdentifier: string;
  smpCnt: number;
  /** Already reduced to RMS by the adapter — raw sample streams are never forwarded upstream. */
  rms: Record<string, number>;
  timestamp: Date;
}

export interface Iec61850Adapter {
  readonly kind: 'native' | 'simulator';
  connectMms(host: string, port: number, credentialsRef?: string): Promise<string>; // returns a session handle
  disconnectMms(handle: string): Promise<void>;
  /** Read a list of object references in one request. */
  readValues(handle: string, references: string[]): Promise<Iec61850DataValue[]>;
  /**
   * Enable a buffered report control block and receive its reports. Buffered (BRCB) rather than
   * unbuffered is deliberate: events that occur while the link is down are retained by the IED and
   * re-delivered on reconnect, so a brief network outage does not create a hole in the fault record.
   */
  subscribeReports(
    handle: string,
    rcbReference: string,
    onReport: (r: Iec61850ReportPayload) => void
  ): Promise<() => void>;
  /** Subscribe to a GOOSE control block on a layer-2 interface. */
  subscribeGoose(
    networkInterface: string,
    goCbReference: string,
    onGoose: (g: GoosePayload) => void
  ): Promise<() => void>;
  /** Subscribe to a Sampled Values stream; the adapter aggregates to RMS before calling back. */
  subscribeSampledValues(
    networkInterface: string,
    svIdentifier: string,
    onSv: (s: SampledValuePayload) => void
  ): Promise<() => void>;
  /** MMS file services. */
  listFiles(handle: string, directory: string): Promise<Array<{ name: string; size: number; modified?: Date }>>;
  getFile(handle: string, path: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------------------------
// Mapping IEC 61850 logical nodes to our protection-function vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * IEC 61850 is self-describing: the logical node class already tells us what the function is, so
 * unlike Modbus there is no address map to maintain. This is the whole reason 61850 is preferred.
 */
export const LOGICAL_NODE_TO_FUNCTION: Record<string, ProtectionFunctionCode> = {
  PTOC: 'OVERCURRENT', // time overcurrent (51)
  PIOC: 'SHORT_CIRCUIT', // instantaneous overcurrent (50)
  PTEF: 'EARTH_FAULT', // transient earth fault
  PSDE: 'EARTH_FAULT', // sensitive directional earth fault
  PTOV: 'OVERVOLTAGE', // 59
  PTUV: 'UNDERVOLTAGE', // 27
  PTOF: 'OVERFREQUENCY', // 81O
  PTUF: 'UNDERFREQUENCY', // 81U
  PDIF: 'TRANSFORMER_DIFFERENTIAL', // 87
  PDIS: 'DISTANCE_PROTECTION', // 21
  PTTR: 'THERMAL_OVERLOAD', // 49
  PTRC: 'OVERCURRENT', // trip conditioning — carries the aggregated trip
  RBRF: 'BREAKER_FAILURE', // 50BF
  PMSS: 'MOTOR_PROTECTION',
  PTUC: 'LOSS_OF_CURRENT',
  PDUP: 'DIRECTIONAL_OVERCURRENT',
};

function functionFromReference(reference: string): ProtectionFunctionCode | undefined {
  // "IED1LD0/PTOC1.Str.general" -> logical node class "PTOC"
  const m = reference.match(/\/([A-Z]{4})\d*\./);
  return m ? LOGICAL_NODE_TO_FUNCTION[m[1]] : undefined;
}

/** Str = start/pickup, Op = operate/trip. This is standard 61850 data-object naming. */
function classifyDataObject(reference: string): 'PICKUP' | 'TRIP' | 'POSITION' | 'HEALTH' | 'MEASUREMENT' | undefined {
  if (/\.Str\b/.test(reference)) return 'PICKUP';
  if (/\.Op\b/.test(reference)) return 'TRIP';
  if (/XCBR\d*\.Pos\b/.test(reference)) return 'POSITION';
  if (/\.(Health|Beh|EEHealth)\b/.test(reference)) return 'HEALTH';
  if (/(MMXU|MMTR)\d*\./.test(reference)) return 'MEASUREMENT';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Simulator adapter
// ---------------------------------------------------------------------------------------------

export class SimulatorIec61850Adapter implements Iec61850Adapter {
  readonly kind = 'simulator' as const;
  private stNum = 1;

  async connectMms(): Promise<string> {
    return `sim-${randomUUID()}`;
  }
  async disconnectMms(): Promise<void> {}

  async readValues(_h: string, references: string[]): Promise<Iec61850DataValue[]> {
    return references.map((reference) => {
      const cls = classifyDataObject(reference);
      let value: number | boolean | string | null = null;
      if (cls === 'MEASUREMENT') value = 400 + Math.random() * 40;
      else if (cls === 'POSITION') value = true;
      else if (cls === 'HEALTH') value = 1; // 1 = Ok in the 61850 Health enum
      else value = false;
      return { reference, value, quality: { validity: 'good' as const }, timestamp: new Date() };
    });
  }

  async subscribeReports(
    _h: string,
    rcbReference: string,
    onReport: (r: Iec61850ReportPayload) => void
  ): Promise<() => void> {
    let seq = 0;
    const timer = setInterval(() => {
      onReport({
        rcbReference,
        dataSetName: 'AnalogValues',
        reason: 'dchg',
        sequenceNumber: seq++,
        values: [
          {
            reference: 'SIMIED/MMXU1.A.phsA.cVal.mag.f',
            value: 400 + Math.random() * 60,
            quality: { validity: 'good' },
            timestamp: new Date(),
          },
        ],
      });
    }, 15000);
    return () => clearInterval(timer);
  }

  async subscribeGoose(
    _iface: string,
    goCbReference: string,
    onGoose: (g: GoosePayload) => void
  ): Promise<() => void> {
    // A real GOOSE publisher retransmits in steady state well inside its time-allowed-to-live
    // (typically ~1 s against a 4 s TTL). The simulator matches that so the TTL supervision in
    // Iec61850GooseDriver only fires when something is genuinely wrong, rather than tripping on
    // the simulator's own publishing gap and filling a demo with false comms alarms.
    let sqNum = 0;
    const timer = setInterval(() => {
      onGoose({
        goCbReference,
        dataSetName: 'TripSignals',
        stNum: this.stNum,
        sqNum: sqNum++,
        timeAllowedToLive: 4000,
        test: false,
        timestamp: new Date(),
        values: [
          { reference: 'SIMIED/PTRC1.Op.general', value: false, quality: { validity: 'good' } },
        ],
      });
    }, 1000);
    return () => clearInterval(timer);
  }

  async subscribeSampledValues(
    _iface: string,
    svIdentifier: string,
    onSv: (s: SampledValuePayload) => void
  ): Promise<() => void> {
    let smpCnt = 0;
    const timer = setInterval(() => {
      onSv({
        svIdentifier,
        smpCnt: (smpCnt += 80),
        rms: { current_A: 400 + Math.random() * 20, voltage_kV: 20 + Math.random() * 0.2 },
        timestamp: new Date(),
      });
    }, 5000);
    return () => clearInterval(timer);
  }

  async listFiles(): Promise<Array<{ name: string; size: number; modified?: Date }>> {
    return [
      { name: 'COMTRADE/REC0001.CFG', size: 2048, modified: new Date() },
      { name: 'COMTRADE/REC0001.DAT', size: 98304, modified: new Date() },
    ];
  }

  async getFile(_h: string, path: string): Promise<Buffer> {
    return Buffer.from(`SIMULATED COMTRADE CONTENT for ${path}\n`, 'utf8');
  }
}

/**
 * Binds the native stack. Wire libiec61850 (or a vendor SDK) here — via node-gyp bindings, a
 * child-process bridge, or a sidecar — and every 61850 driver below starts talking to real IEDs
 * with no other change. Returns null when no native stack is configured.
 */
export function loadNativeAdapter(): Iec61850Adapter | null {
  const modulePath = process.env.IEC61850_NATIVE_ADAPTER;
  if (!modulePath) return null;
  try {
    // Deliberately dynamic: the native module is an optional deployment-time dependency.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath);
    const adapter: Iec61850Adapter = mod.createAdapter ? mod.createAdapter() : mod;
    if (typeof adapter.connectMms !== 'function') {
      throw new Error('adapter does not implement Iec61850Adapter');
    }
    return adapter;
  } catch (err) {
    // Never fail the gateway because an optional native stack is missing or broken — degrade to
    // simulator and make the reason visible in diagnostics instead.
    // eslint-disable-next-line no-console
    console.error(`[iec61850] native adapter failed to load (${(err as Error).message}); using simulator`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// MMS driver
// ---------------------------------------------------------------------------------------------

export class Iec61850MmsDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'IEC61850_MMS';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.IEC61850_MMS.capabilities;

  private handles = new Map<string, string>();
  private unsubs = new Map<string, Array<() => void>>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private lastValues = new Map<string, Record<string, number>>();
  private breakerStatus = new Map<string, string>();
  private lastReportSeq = new Map<string, number>();

  constructor(private adapter: Iec61850Adapter) {
    super();
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    this.setState(path, 'CONNECTING');
    try {
      const handle = await this.adapter.connectMms(path.host ?? '127.0.0.1', path.port ?? 102, path.credentialsRef);
      this.handles.set(path.pathId, handle);
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });

      // Enable the buffered report control block so spontaneous protection events arrive without polling.
      const rcb = String(path.addressing?.reportControlBlock ?? `${profile.relayCode}/LLN0.BR.brcbEvents01`);
      const un = await this.adapter.subscribeReports(handle, rcb, (r) => this.onReport(path, profile, r));
      this.pushUnsub(path.pathId, un);
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  private pushUnsub(pathId: string, fn: () => void) {
    const list = this.unsubs.get(pathId) ?? [];
    list.push(fn);
    this.unsubs.set(pathId, list);
  }

  async disconnect(path: CommPath): Promise<void> {
    (this.unsubs.get(path.pathId) ?? []).forEach((fn) => fn());
    this.unsubs.delete(path.pathId);
    const handle = this.handles.get(path.pathId);
    if (handle) await this.adapter.disconnectMms(handle);
    this.handles.delete(path.pathId);
    this.setState(path, 'DISCONNECTED');
  }

  private onReport(path: CommPath, profile: RelayCommProfile, report: Iec61850ReportPayload) {
    this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });

    // A gap in the report sequence number means the IED buffered more than we received — worth
    // surfacing, because it means the event record for this period may be incomplete.
    if (report.sequenceNumber !== undefined) {
      const prev = this.lastReportSeq.get(path.pathId);
      if (prev !== undefined && report.sequenceNumber > prev + 1) {
        this.emit(path, profile, {
          eventType: 'SECURITY_LOG_EVENT',
          severity: 'MEDIUM',
          message: `Report sequence gap on ${profile.relayCode}: expected ${prev + 1}, received ${report.sequenceNumber}. Some buffered events may not have been delivered.`,
          timestamp: new Date(),
          sourceReference: report.rcbReference,
        });
      }
      this.lastReportSeq.set(path.pathId, report.sequenceNumber);
    }

    for (const v of report.values) this.handleValue(path, profile, v, report.rcbReference);
  }

  private handleValue(path: CommPath, profile: RelayCommProfile, v: Iec61850DataValue, ref: string) {
    if (v.quality && v.quality.validity !== 'good') return; // never raise protection events on bad-quality data
    const cls = classifyDataObject(v.reference);
    const fn = functionFromReference(v.reference);
    const ts = v.timestamp ?? new Date();

    if (cls === 'MEASUREMENT' && typeof v.value === 'number') {
      const store = this.lastValues.get(path.pathId) ?? {};
      const name = /\.A\./.test(v.reference) ? 'current_A' : /\.PhV\.|\.V\./.test(v.reference) ? 'voltage_kV' : /Hz/.test(v.reference) ? 'frequency_Hz' : 'value';
      store[name] = v.value;
      this.lastValues.set(path.pathId, store);
    } else if (cls === 'TRIP' && v.value === true) {
      this.emit(path, profile, {
        eventType: 'PROTECTION_TRIP',
        severity: 'CRITICAL',
        protectionFunction: fn,
        message: `Protection operate (${v.reference.split('/').pop()}) on ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: v.reference,
      });
    } else if (cls === 'PICKUP' && v.value === true) {
      this.emit(path, profile, {
        eventType: 'PROTECTION_PICKUP',
        severity: 'HIGH',
        protectionFunction: fn,
        message: `Protection start (${v.reference.split('/').pop()}) on ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: v.reference,
      });
    } else if (cls === 'POSITION') {
      const status = v.value === true ? 'CLOSED' : v.value === false ? 'OPEN' : 'UNKNOWN';
      if (this.breakerStatus.get(path.pathId) !== status) {
        this.breakerStatus.set(path.pathId, status);
        this.emit(path, profile, {
          eventType: 'BREAKER_STATE_CHANGE',
          severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
          breakerStatus: status as any,
          message: `Breaker ${status.toLowerCase()} on ${profile.relayCode}`,
          timestamp: ts,
          sourceReference: v.reference,
        });
      }
    } else if (cls === 'HEALTH' && typeof v.value === 'number' && v.value !== 1) {
      // 61850 Health enum: 1 = Ok, 2 = Warning, 3 = Alarm.
      this.emit(path, profile, {
        eventType: 'DEVICE_SELF_TEST_FAILED',
        severity: v.value === 3 ? 'HIGH' : 'MEDIUM',
        message: `IED health is ${v.value === 3 ? 'Alarm' : 'Warning'} on ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: ref,
      });
    }
  }

  private emit(
    path: CommPath,
    profile: RelayCommProfile,
    p: {
      eventType: UnifiedEvent['eventType'];
      severity: UnifiedEvent['severity'];
      message: string;
      timestamp: Date;
      protectionFunction?: ProtectionFunctionCode;
      breakerStatus?: UnifiedEvent['breakerStatus'];
      sourceReference?: string;
    }
  ) {
    const event: UnifiedEvent = {
      eventId: randomUUID(),
      timestamp: p.timestamp.toISOString(),
      projectId: '',
      provinceId: '',
      cityId: '',
      relayId: profile.relayId,
      eventType: p.eventType,
      severity: p.severity,
      protectionFunction: p.protectionFunction,
      breakerStatus: p.breakerStatus,
      sourceProtocol: this.protocol,
      message: p.message,
      synthetic: this.adapter.kind === 'simulator',
      timeSyncQuality: 'SUB_MILLISECOND',
      sourcePathId: path.pathId,
      sourceReference: p.sourceReference,
    };
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(event));
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => {
      this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
    };
  }

  async readStatus(path: CommPath, profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const handle = this.handles.get(path.pathId);
    const d = this.diagnostics(path);
    if (!handle) {
      return {
        commStatus: 'OFFLINE',
        breakerStatus: 'UNKNOWN',
        activeSettingGroup: 'UNKNOWN',
        measurements: {},
        lastUpdated: new Date().toISOString(),
        timeSyncQuality: 'UNKNOWN',
        viaPathId: path.pathId,
      };
    }

    const ld = String(path.addressing?.logicalDevice ?? profile.relayCode);
    const refs = [
      `${ld}/MMXU1.A.phsA.cVal.mag.f`,
      `${ld}/MMXU1.PhV.phsA.cVal.mag.f`,
      `${ld}/MMXU1.Hz.mag.f`,
      `${ld}/XCBR1.Pos.stVal`,
      `${ld}/LLN0.Health.stVal`,
      // Active setting group — read-only. We report which group is active; we never select one.
      `${ld}/LLN0.SGCB.ActSG`,
    ];

    const values = await this.adapter.readValues(handle, refs);
    this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });

    const measurements: Record<string, number> = { ...(this.lastValues.get(path.pathId) ?? {}) };
    let breaker = this.breakerStatus.get(path.pathId) ?? 'UNKNOWN';
    let settingGroup = 'UNKNOWN';
    const health: Record<string, string | number | boolean> = {};

    for (const v of values) {
      if (/MMXU1\.A\./.test(v.reference) && typeof v.value === 'number') measurements.current_A = v.value;
      else if (/MMXU1\.PhV\./.test(v.reference) && typeof v.value === 'number') measurements.voltage_kV = v.value;
      else if (/MMXU1\.Hz/.test(v.reference) && typeof v.value === 'number') measurements.frequency_Hz = v.value;
      else if (/XCBR1\.Pos/.test(v.reference)) breaker = v.value === true ? 'CLOSED' : v.value === false ? 'OPEN' : 'UNKNOWN';
      else if (/ActSG/.test(v.reference)) settingGroup = `Group ${v.value}`;
      else if (/Health/.test(v.reference)) health.iedHealth = v.value === 1 ? 'Ok' : v.value === 2 ? 'Warning' : 'Alarm';
    }

    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: breaker,
      activeSettingGroup: settingGroup,
      measurements,
      deviceHealth: health,
      lastUpdated: new Date().toISOString(),
      timeSyncQuality: 'SUB_MILLISECOND',
      viaPathId: path.pathId,
    };
  }

  // --- File services (COMTRADE) ---------------------------------------------------------------

  async listDisturbanceFiles(path: CommPath, _profile: RelayCommProfile): Promise<DisturbanceFileRef[]> {
    const handle = this.handles.get(path.pathId);
    if (!handle) return [];
    const dir = String(path.addressing?.comtradeDirectory ?? 'COMTRADE');
    const files = await this.adapter.listFiles(handle, dir);

    // Group the parts of each COMTRADE set (.CFG/.DAT/.HDR/.INF) into one logical record.
    const groups = new Map<string, DisturbanceFileRef>();
    for (const f of files) {
      const base = f.name.replace(/\.(CFG|DAT|HDR|INF)$/i, '');
      const g = groups.get(base) ?? { remoteId: base, fileNames: [], recordedAt: f.modified?.toISOString(), sizeBytes: 0 };
      g.fileNames.push(f.name);
      g.sizeBytes = (g.sizeBytes ?? 0) + f.size;
      groups.set(base, g);
    }
    return [...groups.values()];
  }

  async retrieveDisturbanceFile(
    path: CommPath,
    _profile: RelayCommProfile,
    ref: DisturbanceFileRef
  ): Promise<RetrievedDisturbanceFile[]> {
    const handle = this.handles.get(path.pathId);
    if (!handle) return [];
    const out: RetrievedDisturbanceFile[] = [];
    for (const name of ref.fileNames) {
      const content = await this.adapter.getFile(handle, name);
      out.push({ remoteId: ref.remoteId, fileName: name, content, format: detectComtradeFormat(name, content) });
    }
    return out;
  }
}

function detectComtradeFormat(name: string, content: Buffer): RetrievedDisturbanceFile['format'] {
  if (!/\.CFG$/i.test(name)) return /\.DAT$/i.test(name) ? 'UNKNOWN' : 'VENDOR_BINARY';
  const head = content.subarray(0, 512).toString('ascii');
  if (head.includes('2013')) return 'COMTRADE_2013';
  if (head.includes('1999')) return 'COMTRADE_1999';
  return 'COMTRADE_1991';
}

// ---------------------------------------------------------------------------------------------
// GOOSE driver
// ---------------------------------------------------------------------------------------------

/**
 * GOOSE is the fastest signal available — trip and interlock messages in single-digit milliseconds.
 * It is layer-2 multicast, so it is not routable: the gateway must be on the station bus VLAN and
 * the process needs raw-socket capability (CAP_NET_RAW).
 *
 * Two GOOSE-specific health signals are monitored here, because both indicate a real problem that
 * a naive subscriber would miss:
 *  - stNum jumping by more than one: a state change was missed entirely.
 *  - no message within timeAllowedToLive: the publisher has gone silent, which for GOOSE means the
 *    protection scheme's peer-to-peer signalling is degraded, not merely that monitoring is blind.
 */
export class Iec61850GooseDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'IEC61850_GOOSE';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.IEC61850_GOOSE.capabilities;

  private unsubs = new Map<string, () => void>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private lastStNum = new Map<string, number>();
  private ttlTimers = new Map<string, NodeJS.Timeout>();
  private lastValues = new Map<string, Map<string, boolean | number | string | null>>();

  constructor(private adapter: Iec61850Adapter) {
    super();
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    this.setState(path, 'CONNECTING');
    try {
      const iface = String(path.addressing?.networkInterface ?? process.env.GOOSE_INTERFACE ?? 'eth0');
      const gocb = String(path.addressing?.gooseControlBlock ?? `${profile.relayCode}/LLN0.gcbTrip`);
      const un = await this.adapter.subscribeGoose(iface, gocb, (g) => this.onGoose(path, profile, g));
      this.unsubs.set(path.pathId, un);
      this.setState(path, 'CONNECTED');
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  async disconnect(path: CommPath): Promise<void> {
    this.unsubs.get(path.pathId)?.();
    this.unsubs.delete(path.pathId);
    const t = this.ttlTimers.get(path.pathId);
    if (t) clearTimeout(t);
    this.setState(path, 'DISCONNECTED');
  }

  private onGoose(path: CommPath, profile: RelayCommProfile, g: GoosePayload) {
    this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });

    // A publisher marking its dataset as test must never raise an operational alarm — this is how
    // relay engineers do maintenance testing without generating false control-room events.
    if (g.test) return;

    // TTL supervision: rearm on every message; fire if the publisher goes quiet.
    const existing = this.ttlTimers.get(path.pathId);
    if (existing) clearTimeout(existing);
    this.ttlTimers.set(
      path.pathId,
      setTimeout(() => {
        this.emit(path, profile, {
          eventType: 'COMM_LOST',
          severity: 'HIGH',
          message: `GOOSE publisher ${g.goCbReference} silent beyond its time-allowed-to-live (${g.timeAllowedToLive} ms). Peer-to-peer protection signalling is degraded.`,
          timestamp: new Date(),
          sourceReference: g.goCbReference,
        });
      }, Math.max(g.timeAllowedToLive * 2, 4000))
    );

    const prev = this.lastStNum.get(path.pathId);
    if (prev !== undefined && g.stNum > prev + 1) {
      this.emit(path, profile, {
        eventType: 'GOOSE_SEQUENCE_ANOMALY',
        severity: 'MEDIUM',
        message: `GOOSE state number jumped from ${prev} to ${g.stNum} on ${g.goCbReference} — at least one state change was not received.`,
        timestamp: g.timestamp,
        sourceReference: g.goCbReference,
      });
    }
    const stateChanged = prev === undefined || g.stNum !== prev;
    this.lastStNum.set(path.pathId, g.stNum);

    // Only a state change carries new information; retransmissions (sqNum increments) do not.
    if (!stateChanged) return;

    const store = this.lastValues.get(path.pathId) ?? new Map();
    for (const v of g.values) {
      const previous = store.get(v.reference);
      store.set(v.reference, v.value);
      if (previous === v.value) continue;

      const cls = classifyDataObject(v.reference);
      const fn = functionFromReference(v.reference);
      if (cls === 'TRIP' && v.value === true) {
        this.emit(path, profile, {
          eventType: 'PROTECTION_TRIP',
          severity: 'CRITICAL',
          protectionFunction: fn,
          message: `GOOSE trip signal ${v.reference.split('/').pop()} asserted on ${profile.relayCode}`,
          timestamp: g.timestamp,
          sourceReference: `${g.goCbReference} stNum=${g.stNum}`,
        });
      } else if (cls === 'PICKUP' && v.value === true) {
        this.emit(path, profile, {
          eventType: 'PROTECTION_PICKUP',
          severity: 'HIGH',
          protectionFunction: fn,
          message: `GOOSE start signal ${v.reference.split('/').pop()} asserted on ${profile.relayCode}`,
          timestamp: g.timestamp,
          sourceReference: `${g.goCbReference} stNum=${g.stNum}`,
        });
      } else if (cls === 'POSITION') {
        const status = v.value === true ? 'CLOSED' : 'OPEN';
        this.emit(path, profile, {
          eventType: 'BREAKER_STATE_CHANGE',
          severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
          breakerStatus: status as any,
          message: `GOOSE breaker position ${status.toLowerCase()} on ${profile.relayCode}`,
          timestamp: g.timestamp,
          sourceReference: `${g.goCbReference} stNum=${g.stNum}`,
        });
      }
    }
    this.lastValues.set(path.pathId, store);
  }

  private emit(
    path: CommPath,
    profile: RelayCommProfile,
    p: {
      eventType: UnifiedEvent['eventType'];
      severity: UnifiedEvent['severity'];
      message: string;
      timestamp: Date;
      protectionFunction?: ProtectionFunctionCode;
      breakerStatus?: UnifiedEvent['breakerStatus'];
      sourceReference?: string;
    }
  ) {
    const event: UnifiedEvent = {
      eventId: randomUUID(),
      timestamp: p.timestamp.toISOString(),
      projectId: '',
      provinceId: '',
      cityId: '',
      relayId: profile.relayId,
      eventType: p.eventType,
      severity: p.severity,
      protectionFunction: p.protectionFunction,
      breakerStatus: p.breakerStatus,
      sourceProtocol: this.protocol,
      message: p.message,
      synthetic: this.adapter.kind === 'simulator',
      timeSyncQuality: 'SUB_MILLISECOND',
      sourcePathId: path.pathId,
      sourceReference: p.sourceReference,
    };
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(event));
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => {
      this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
    };
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    // GOOSE is push-only; the "status" is whatever the last received state said.
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'SUB_MILLISECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Sampled Values driver
// ---------------------------------------------------------------------------------------------

/**
 * IEC 61850-9-2 Sampled Values from merging units. The raw stream is 80 samples per cycle per
 * channel — at 50 Hz that is 4000 samples/second/channel, far too much to forward upstream. The
 * adapter aggregates to RMS and this driver forwards only derived measurements, which is the
 * correct architectural boundary: high-rate data stays at the edge.
 */
export class Iec61850SvDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'IEC61850_SV';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.IEC61850_SV.capabilities;

  private unsubs = new Map<string, () => void>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private latest = new Map<string, Record<string, number>>();
  private lastSmpCnt = new Map<string, number>();

  constructor(private adapter: Iec61850Adapter) {
    super();
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    this.setState(path, 'CONNECTING');
    try {
      const iface = String(path.addressing?.networkInterface ?? process.env.GOOSE_INTERFACE ?? 'eth0');
      const svId = String(path.addressing?.svIdentifier ?? `${profile.relayCode}_SV`);
      const un = await this.adapter.subscribeSampledValues(iface, svId, (s) => {
        this.noteData(path, { timeSyncQuality: 'SUB_MICROSECOND' });
        this.latest.set(path.pathId, s.rms);

        // A sample-count discontinuity means the SV stream dropped frames. For a protection scheme
        // fed by SV this is significant, so it is reported rather than silently smoothed over.
        const prev = this.lastSmpCnt.get(path.pathId);
        if (prev !== undefined && s.smpCnt !== 0 && s.smpCnt < prev) {
          const event: UnifiedEvent = {
            eventId: randomUUID(),
            timestamp: s.timestamp.toISOString(),
            projectId: '',
            provinceId: '',
            cityId: '',
            relayId: profile.relayId,
            eventType: 'COMM_LOST',
            severity: 'MEDIUM',
            sourceProtocol: this.protocol,
            message: `Sampled Values stream ${s.svIdentifier} sample count reset (${prev} -> ${s.smpCnt}); merging unit may have restarted.`,
            synthetic: this.adapter.kind === 'simulator',
            timeSyncQuality: 'SUB_MICROSECOND',
            sourcePathId: path.pathId,
            sourceReference: s.svIdentifier,
          };
          (this.listeners.get(path.pathId) ?? []).forEach((l) => l(event));
        }
        this.lastSmpCnt.set(path.pathId, s.smpCnt);
      });
      this.unsubs.set(path.pathId, un);
      this.setState(path, 'CONNECTED');
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  async disconnect(path: CommPath): Promise<void> {
    this.unsubs.get(path.pathId)?.();
    this.unsubs.delete(path.pathId);
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => {
      this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
    };
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.latest.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'SUB_MICROSECOND',
      viaPathId: path.pathId,
    };
  }
}
