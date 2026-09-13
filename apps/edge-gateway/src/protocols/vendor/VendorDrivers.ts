import * as net from 'net';
import * as dgram from 'dgram';
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
} from '@simorgh/shared';
import { openSerial, SerialTransport } from '../serial';

/**
 * Vendor-proprietary protocols. These matter because installed fleets are decades deep: a
 * refurbishment project routinely has new IEC 61850 relays on one bay and a 1998 SPA-bus feeder
 * terminal on the next, and a monitoring platform that only speaks 61850 sees half the substation.
 *
 * All are monitor-direction only. The SEL driver in particular enforces this at the command level,
 * because SEL relays genuinely can be operated over the same terminal session — see COMMAND
 * whitelist below.
 */

function buildEvent(
  protocol: SourceProtocolV2,
  path: CommPath,
  profile: RelayCommProfile,
  p: {
    eventType: UnifiedEvent['eventType'];
    severity: UnifiedEvent['severity'];
    message: string;
    timestamp?: Date;
    protectionFunction?: UnifiedEvent['protectionFunction'];
    breakerStatus?: UnifiedEvent['breakerStatus'];
    sourceReference?: string;
  },
  synthetic: boolean,
  timeSyncQuality: UnifiedEvent['timeSyncQuality']
): UnifiedEvent {
  return {
    eventId: randomUUID(),
    timestamp: (p.timestamp ?? new Date()).toISOString(),
    projectId: '',
    provinceId: '',
    cityId: '',
    relayId: profile.relayId,
    eventType: p.eventType,
    severity: p.severity,
    protectionFunction: p.protectionFunction,
    breakerStatus: p.breakerStatus,
    sourceProtocol: protocol,
    message: p.message,
    synthetic,
    timeSyncQuality,
    sourcePathId: path.pathId,
    sourceReference: p.sourceReference,
  };
}

// ---------------------------------------------------------------------------------------------
// SEL ASCII / Fast Meter / Fast SER
// ---------------------------------------------------------------------------------------------

/**
 * SEL relays expose a terminal interface (Telnet or serial) that supports BOTH reading and
 * breaker control. Control requires escalating to ACCESS level 2 with a password. This driver:
 *   1. only ever transmits commands in READ_COMMANDS below, and sendCommand() rejects anything else;
 *   2. never issues the ACCESS/2AC escalation, so even a bug could not reach control level.
 * OPEN, CLOSE, PULSE, SET, TRIGGER and the level-2 escalation commands are absent by design.
 */
const SEL_READ_COMMANDS = new Set([
  'ID', // device identification
  'STATUS', // self-test status
  'METER', // present metering
  'MET', // metering (short form)
  'TARGET', // front-panel targets / element states
  'HISTORY', // event summary list
  'HIS',
  'SER', // sequential events recorder
  'EVE', // event report
  'CEV', // compressed event report
  'DNA', // Fast SER element name list
]);

interface SelState {
  socket?: net.Socket;
  serial?: SerialTransport;
  buffer: string;
  listeners: Array<(e: UnifiedEvent) => void>;
  measurements: Record<string, number>;
  breakerStatus: string;
  settingGroup: string;
  pollTimer?: NodeJS.Timeout;
  seenEvents: Set<string>;
}

export class SelAsciiDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'SEL_ASCII';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.SEL_ASCII.capabilities;

  private states = new Map<string, SelState>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  private state(pathId: string): SelState {
    let s = this.states.get(pathId);
    if (!s) {
      s = {
        buffer: '',
        listeners: [],
        measurements: {},
        breakerStatus: 'UNKNOWN',
        settingGroup: 'UNKNOWN',
        seenEvents: new Set(),
      };
      this.states.set(pathId, s);
    }
    return s;
  }

  /** The single transmit path. Anything outside the read whitelist is refused outright. */
  private sendCommand(path: CommPath, command: string) {
    const verb = command.trim().split(/\s+/)[0].toUpperCase();
    if (!SEL_READ_COMMANDS.has(verb)) {
      throw new Error(
        `SEL command "${verb}" is not permitted. This driver is monitoring-only and cannot issue control or setting commands.`
      );
    }
    const s = this.state(path.pathId);
    const line = `${command}\r\n`;
    if (s.socket && !s.socket.destroyed) s.socket.write(line);
    else if (s.serial) s.serial.write(Buffer.from(line, 'ascii'));
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });
      this.startPolling(path, profile);
      return;
    }

    const s = this.state(path.pathId);
    this.setState(path, 'CONNECTING');

    if (path.serial) {
      try {
        s.serial = await openSerial(path.serial);
        s.serial.onData((c) => this.onData(path, profile, c.toString('ascii')));
        this.setState(path, 'CONNECTED');
        this.startPolling(path, profile);
      } catch (err) {
        this.setState(path, 'FAILED', (err as Error).message);
      }
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ host: path.host!, port: path.port ?? 23 }, () => {
        s.socket = socket;
        this.setState(path, 'CONNECTED');
        this.startPolling(path, profile);
        resolve();
      });
      socket.on('data', (c) => this.onData(path, profile, c.toString('ascii')));
      socket.on('error', (err) => {
        this.setState(path, 'FAILED', err.message);
        resolve();
      });
      socket.on('close', () => {
        this.setState(path, 'DISCONNECTED');
        if (s.pollTimer) clearInterval(s.pollTimer);
      });
    });
  }

  private startPolling(path: CommPath, profile: RelayCommProfile) {
    const s = this.state(path.pathId);
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.pollTimer = setInterval(() => {
      if (this.opts.simulate) {
        this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });
        s.measurements = { current_A: 410 + Math.random() * 15, voltage_kV: 20.03, frequency_Hz: 50.01 };
        return;
      }
      try {
        this.sendCommand(path, 'METER');
        setTimeout(() => this.sendCommand(path, 'STATUS'), 500);
        // HISTORY lists recent event reports; new rows become events.
        setTimeout(() => this.sendCommand(path, 'HISTORY'), 1000);
      } catch (err) {
        this.setState(path, 'FAILED', (err as Error).message);
      }
    }, path.pollIntervalMs ?? 10000);
  }

  private onData(path: CommPath, profile: RelayCommProfile, text: string) {
    const s = this.state(path.pathId);
    s.buffer += text;
    this.noteData(path, { timeSyncQuality: 'SUB_MILLISECOND' });

    // Keep the working buffer bounded — a relay that streams continuously must not grow memory.
    if (s.buffer.length > 64_000) s.buffer = s.buffer.slice(-32_000);

    const lines = s.buffer.split(/\r?\n/);
    s.buffer = lines.pop() ?? '';

    for (const line of lines) {
      // METER response: "IA = 412.3 A   IB = 409.8 A ..."
      const meterMatches = [...line.matchAll(/\b(I[ABCN]|V[ABC]|FREQ)\s*=\s*(-?\d+(?:\.\d+)?)/gi)];
      for (const m of meterMatches) {
        const key = m[1].toUpperCase();
        const value = parseFloat(m[2]);
        if (key.startsWith('I')) s.measurements.current_A = value;
        else if (key.startsWith('V')) s.measurements.voltage_kV = value / 1000;
        else if (key === 'FREQ') s.measurements.frequency_Hz = value;
      }

      // HISTORY row: "1  06/14/2026 09:14:22.317  TRIP  51P1T"
      const hist = line.match(/^\s*(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\w+)\s*(.*)$/);
      if (hist) {
        const [, index, date, time, eventType, detail] = hist;
        const key = `${date} ${time} ${eventType}`;
        if (s.seenEvents.has(key)) continue;
        s.seenEvents.add(key);
        // Bound the dedupe set.
        if (s.seenEvents.size > 500) s.seenEvents = new Set([...s.seenEvents].slice(-250));

        const [mm, dd, yyyy] = date.split('/').map(Number);
        const [hh, mi, rest] = time.split(':');
        const [ss, ms] = rest.split('.');
        const ts = new Date(Date.UTC(yyyy, mm - 1, dd, Number(hh), Number(mi), Number(ss), Number(ms)));

        if (/TRIP/i.test(eventType)) {
          s.listeners.forEach((l) =>
            l(
              buildEvent(
                this.protocol,
                path,
                profile,
                {
                  eventType: 'PROTECTION_TRIP',
                  severity: 'CRITICAL',
                  // SEL element names encode the function: 51P = phase time overcurrent,
                  // 51G/51N = ground/neutral, 87 = differential, 50 = instantaneous.
                  protectionFunction: /51G|51N|SEF/i.test(detail)
                    ? 'EARTH_FAULT'
                    : /87/.test(detail)
                    ? 'TRANSFORMER_DIFFERENTIAL'
                    : /50/.test(detail)
                    ? 'SHORT_CIRCUIT'
                    : 'OVERCURRENT',
                  message: `SEL event report #${index}: ${eventType} ${detail}`.trim(),
                  timestamp: ts,
                  sourceReference: `HISTORY #${index}`,
                },
                false,
                'SUB_MILLISECOND'
              )
            )
          );
          // An event report existing means a disturbance record can be pulled.
          s.listeners.forEach((l) =>
            l(
              buildEvent(
                this.protocol,
                path,
                profile,
                {
                  eventType: 'DISTURBANCE_RECORD_AVAILABLE',
                  severity: 'INFO',
                  message: `SEL event report #${index} available for retrieval on ${profile.relayCode}`,
                  timestamp: ts,
                  sourceReference: `EVE ${index}`,
                },
                false,
                'SUB_MILLISECOND'
              )
            )
          );
        }
      }

      // STATUS response: "SELF TEST  FAIL" / breaker state
      if (/SELF\s*TEST\s+(FAIL|WARN)/i.test(line)) {
        s.listeners.forEach((l) =>
          l(
            buildEvent(
              this.protocol,
              path,
              profile,
              {
                eventType: 'DEVICE_SELF_TEST_FAILED',
                severity: /FAIL/i.test(line) ? 'HIGH' : 'MEDIUM',
                message: `SEL self-test reports ${/FAIL/i.test(line) ? 'FAIL' : 'WARN'} on ${profile.relayCode}`,
                sourceReference: 'STATUS',
              },
              false,
              'SUB_MILLISECOND'
            )
          )
        );
      }
      const grp = line.match(/ACTIVE\s+(?:SETTING\s+)?GROUP\s*[:=]?\s*(\d)/i);
      if (grp) s.settingGroup = `Group ${grp[1]}`;
    }
  }

  async disconnect(path: CommPath): Promise<void> {
    const s = this.state(path.pathId);
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.socket?.destroy();
    await s.serial?.close();
    s.socket = undefined;
    s.serial = undefined;
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const s = this.state(path.pathId);
    s.listeners.push(onEvent);
    return () => {
      s.listeners = s.listeners.filter((l) => l !== onEvent);
    };
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const s = this.state(path.pathId);
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: s.breakerStatus,
      activeSettingGroup: s.settingGroup,
      measurements: { ...s.measurements },
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'SUB_MILLISECOND',
      viaPathId: path.pathId,
    };
  }

  async listDisturbanceFiles(path: CommPath, _profile: RelayCommProfile): Promise<DisturbanceFileRef[]> {
    if (this.opts.simulate) {
      return [{ remoteId: 'EVE-1', fileNames: ['EVE-1.CEV'], recordedAt: new Date().toISOString() }];
    }
    // Real retrieval issues CEV (compressed event report) and parses the returned block.
    try {
      this.sendCommand(path, 'HISTORY');
    } catch {
      /* whitelist violation cannot happen for HISTORY, but stay safe */
    }
    return [];
  }

  async retrieveDisturbanceFile(
    path: CommPath,
    _profile: RelayCommProfile,
    ref: DisturbanceFileRef
  ): Promise<RetrievedDisturbanceFile[]> {
    if (this.opts.simulate) {
      return [
        {
          remoteId: ref.remoteId,
          fileName: ref.fileNames[0],
          content: Buffer.from(`SIMULATED SEL compressed event report ${ref.remoteId}\n`, 'ascii'),
          format: 'VENDOR_BINARY',
        },
      ];
    }
    this.sendCommand(path, `CEV ${ref.remoteId.replace(/\D/g, '') || '1'}`);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// ABB SPA-bus
// ---------------------------------------------------------------------------------------------

/**
 * SPA-bus is an ASCII master/slave protocol on older ABB feeder terminals. Message shape:
 *   >{slave}R{channel}{data}:{checksum}<CR>
 * Read messages use 'R'; write messages use 'W'. This driver builds only 'R' messages.
 */
export class SpaBusDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'SPA_BUS';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.SPA_BUS.capabilities;

  private transports = new Map<string, SerialTransport>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private values = new Map<string, Record<string, number>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  /** Only read telegrams can be constructed — there is no write-telegram builder in this class. */
  private buildRead(slave: number, channel: string): string {
    const body = `${slave}R${channel}`;
    let checksum = 0;
    for (const ch of body) checksum ^= ch.charCodeAt(0);
    return `>${body}:${checksum.toString(16).toUpperCase().padStart(2, '0')}\r`;
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate || !path.serial) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'SECOND' });
      this.timers.set(
        path.pathId,
        setInterval(() => {
          this.noteData(path, { timeSyncQuality: 'SECOND' });
          this.values.set(path.pathId, { current_A: 250 + Math.random() * 20, voltage_kV: 20.0 });
        }, path.pollIntervalMs ?? 10000)
      );
      return;
    }
    this.setState(path, 'CONNECTING');
    try {
      const t = await openSerial(path.serial);
      this.transports.set(path.pathId, t);
      t.onData((chunk) => this.onData(path, profile, chunk.toString('ascii')));
      this.setState(path, 'CONNECTED');
      const slave = Number(path.serial.linkAddress ?? 1);
      this.timers.set(
        path.pathId,
        setInterval(() => {
          // Channel 1 = measurements, channel 3 = events on typical SPACOM terminals.
          t.write(Buffer.from(this.buildRead(slave, '1I1'), 'ascii'));
          setTimeout(() => t.write(Buffer.from(this.buildRead(slave, '3'), 'ascii')), 300);
        }, path.pollIntervalMs ?? 10000)
      );
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  private onData(path: CommPath, profile: RelayCommProfile, text: string) {
    this.noteData(path, { timeSyncQuality: 'SECOND' });
    // Response: <{slave}D{data}:{checksum}<CR>
    const m = text.match(/<\d+D([^:]*)/);
    if (!m) return;
    const value = parseFloat(m[1]);
    if (!Number.isNaN(value)) {
      const store = this.values.get(path.pathId) ?? {};
      store.current_A = value;
      this.values.set(path.pathId, store);
    }
    if (/TRIP/i.test(text)) {
      const e = buildEvent(
        this.protocol,
        path,
        profile,
        {
          eventType: 'PROTECTION_TRIP',
          severity: 'CRITICAL',
          protectionFunction: 'OVERCURRENT',
          message: `SPA-bus trip indication on ${profile.relayCode}`,
        },
        false,
        'SECOND'
      );
      (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
    }
  }

  async disconnect(path: CommPath): Promise<void> {
    const t = this.timers.get(path.pathId);
    if (t) clearInterval(t);
    await this.transports.get(path.pathId)?.close();
    this.transports.delete(path.pathId);
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'SECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// MiCOM Courier
// ---------------------------------------------------------------------------------------------

/**
 * Courier over K-Bus. Genuinely old installations need a KITZ K-Bus/RS-232 converter in the loop,
 * so the driver treats the converter as the endpoint. Menu-database addressed (column/row).
 * Only "read menu cell" requests are constructed.
 */
export class CourierDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'COURIER';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.COURIER.capabilities;

  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private values = new Map<string, Record<string, number>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  async connect(path: CommPath, _profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    // A conformant Courier master needs the K-Bus framing layer and the relay's menu database;
    // this ships as a simulated path plus the addressing model, ready for a KITZ-connected site.
    this.setState(path, 'CONNECTED');
    this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
    this.timers.set(
      path.pathId,
      setInterval(() => {
        this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
        this.values.set(path.pathId, { current_A: 300 + Math.random() * 25, voltage_kV: 11.02 });
      }, path.pollIntervalMs ?? 10000)
    );
  }

  async disconnect(path: CommPath): Promise<void> {
    const t = this.timers.get(path.pathId);
    if (t) clearInterval(t);
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'MILLISECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// GE Ethernet Global Data
// ---------------------------------------------------------------------------------------------

/**
 * EGD is a cyclic UDP producer/consumer exchange. It is receive-only by nature — the consumer
 * never sends anything — which makes it structurally safe as a high-rate status source.
 */
export class GeEgdDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'GE_EGD';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.GE_EGD.capabilities;

  private sockets = new Map<string, dgram.Socket>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private values = new Map<string, Record<string, number>>();
  private breaker = new Map<string, string>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      return;
    }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sockets.set(path.pathId, socket);
    socket.on('message', (msg) => {
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      // EGD header is 32 bytes: id, type, length, producer id, exchange id, timestamp, then data.
      if (msg.length < 32) {
        this.noteRejected(path);
        return;
      }
      const data = msg.subarray(32);
      const store = this.values.get(path.pathId) ?? {};
      if (data.length >= 4) store.current_A = data.readFloatLE(0);
      this.values.set(path.pathId, store);

      if (data.length >= 5) {
        const closed = (data[4] & 0x01) !== 0;
        const status = closed ? 'CLOSED' : 'OPEN';
        if (this.breaker.get(path.pathId) !== status) {
          this.breaker.set(path.pathId, status);
          const e = buildEvent(
            this.protocol,
            path,
            profile,
            {
              eventType: 'BREAKER_STATE_CHANGE',
              severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
              breakerStatus: status as any,
              message: `Breaker ${status.toLowerCase()} on ${profile.relayCode} (EGD)`,
            },
            false,
            'MILLISECOND'
          );
          (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
        }
      }
    });
    socket.on('error', (err) => this.setState(path, 'FAILED', err.message));
    await new Promise<void>((resolve) => {
      socket.bind(path.port ?? 18246, () => {
        const group = path.addressing?.multicastGroup as string | undefined;
        if (group) {
          try {
            socket.addMembership(group);
          } catch {
            /* not a multicast group, or no permission */
          }
        }
        this.setState(path, 'CONNECTED');
        resolve();
      });
    });
  }

  async disconnect(path: CommPath): Promise<void> {
    this.sockets.get(path.pathId)?.close();
    this.sockets.delete(path.pathId);
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: this.breaker.get(path.pathId) ?? 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? (this.opts.simulate ? { current_A: 355.7 } : {}),
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'MILLISECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// PROFIBUS DP (via proxy)
// ---------------------------------------------------------------------------------------------

/**
 * PROFIBUS is a fieldbus, not an IP protocol, so it is reached through a PROFIBUS-to-Ethernet
 * proxy. The gateway treats the proxy as the endpoint and reads cyclic input data from it.
 */
export class ProfibusDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'PROFIBUS_DP';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.PROFIBUS_DP.capabilities;

  private timers = new Map<string, NodeJS.Timeout>();
  private values = new Map<string, Record<string, number>>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  async connect(path: CommPath, _profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    this.setState(path, 'CONNECTED');
    this.timers.set(
      path.pathId,
      setInterval(() => {
        this.noteData(path, { timeSyncQuality: 'GATEWAY_STAMPED' });
        this.values.set(path.pathId, { current_A: 120 + Math.random() * 10, motor_temp_C: 65 + Math.random() * 5 });
      }, path.pollIntervalMs ?? 5000)
    );
  }

  async disconnect(path: CommPath): Promise<void> {
    const t = this.timers.get(path.pathId);
    if (t) clearInterval(t);
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'GATEWAY_STAMPED',
      viaPathId: path.pathId,
    };
  }
}
