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
import { PointMap, resolvePoint } from '../pointMap';
import { SerialTransport, openSerial } from '../serial';
import { decodeAsdu, CauseOfTransmission } from './asdu';

/**
 * IEC 60870-5-101 and -103 over serial.
 *
 * -101 is the serial ancestor of -104 and shares its ASDU layer entirely; only the link layer
 * differs (FT1.2 fixed/variable frames with an unbalanced polling master instead of TCP/APCI).
 *
 * -103 is the protection-equipment companion standard and is the more valuable of the two for this
 * platform. Its key property: protection semantics are STANDARDISED as Information Numbers (INF)
 * within Function Type 128 (protection). INF 68 means "general trip" on every compliant relay,
 * regardless of vendor. That makes -103 the one legacy protocol where protection meaning does not
 * depend on a per-vendor register map — which is exactly why it is still worth supporting on older
 * SIPROTEC 4 / MiCOM / REF fleets rather than pushing everything onto Modbus.
 *
 * MONITOR DIRECTION ONLY. The only frames transmitted are: request status of link, request user
 * data class 1/2, reset of remote link, and (for -103) general interrogation and disturbance-record
 * upload requests. No command frame is constructed anywhere in this file.
 */

// FT1.2 control field bits (master -> slave, PRM = 1).
const PRM = 0x40;
const FCB = 0x20;
const FCV = 0x10;
const FN_RESET_REMOTE_LINK = 0x00;
const FN_REQUEST_USER_DATA_1 = 0x0a;
const FN_REQUEST_USER_DATA_2 = 0x0b;
const FN_REQUEST_STATUS_LINK = 0x09;

/**
 * Standardised IEC 60870-5-103 protection information numbers (function type 128).
 * These are from the standard's compatible range, so they carry the same meaning across vendors.
 */
export const IEC103_INF: Record<number, { name: string; kind: 'PICKUP' | 'TRIP' | 'HEALTH' | 'STATE'; fn?: ProtectionFunctionCode }> = {
  16: { name: 'Auto-recloser active', kind: 'STATE' },
  17: { name: 'Teleprotection active', kind: 'STATE' },
  18: { name: 'Protection active', kind: 'STATE' },
  19: { name: 'LED reset', kind: 'STATE' },
  22: { name: 'Setting group 1 active', kind: 'STATE' },
  23: { name: 'Setting group 2 active', kind: 'STATE' },
  24: { name: 'Setting group 3 active', kind: 'STATE' },
  25: { name: 'Setting group 4 active', kind: 'STATE' },
  32: { name: 'Measurand supervision I', kind: 'HEALTH' },
  33: { name: 'Measurand supervision V', kind: 'HEALTH' },
  35: { name: 'Phase sequence supervision', kind: 'HEALTH' },
  36: { name: 'Trip circuit supervision', kind: 'HEALTH', fn: 'TRIP_CIRCUIT_FAILURE' },
  38: { name: 'VT fuse failure', kind: 'HEALTH', fn: 'LOSS_OF_VOLTAGE' },
  46: { name: 'Group warning', kind: 'HEALTH' },
  47: { name: 'Group alarm', kind: 'HEALTH' },
  64: { name: 'Start/pickup L1', kind: 'PICKUP', fn: 'OVERCURRENT' },
  65: { name: 'Start/pickup L2', kind: 'PICKUP', fn: 'OVERCURRENT' },
  66: { name: 'Start/pickup L3', kind: 'PICKUP', fn: 'OVERCURRENT' },
  67: { name: 'Start/pickup earth', kind: 'PICKUP', fn: 'EARTH_FAULT' },
  68: { name: 'General trip', kind: 'TRIP' },
  69: { name: 'Trip L1', kind: 'TRIP', fn: 'OVERCURRENT' },
  70: { name: 'Trip L2', kind: 'TRIP', fn: 'OVERCURRENT' },
  71: { name: 'Trip L3', kind: 'TRIP', fn: 'OVERCURRENT' },
  72: { name: 'Trip earth', kind: 'TRIP', fn: 'EARTH_FAULT' },
  73: { name: 'Fault forward/line', kind: 'STATE' },
  74: { name: 'Fault reverse/busbar', kind: 'STATE' },
  84: { name: 'General start/pickup', kind: 'PICKUP' },
  85: { name: 'Breaker failure', kind: 'TRIP', fn: 'BREAKER_FAILURE' },
  90: { name: 'Trip I>', kind: 'TRIP', fn: 'OVERCURRENT' },
  91: { name: 'Trip I>>', kind: 'TRIP', fn: 'SHORT_CIRCUIT' },
  92: { name: 'Trip IN>', kind: 'TRIP', fn: 'EARTH_FAULT' },
  93: { name: 'Trip IN>>', kind: 'TRIP', fn: 'EARTH_FAULT' },
  128: { name: 'Distance zone 1', kind: 'TRIP', fn: 'DISTANCE_PROTECTION' },
};

interface SerialIecState {
  transport?: SerialTransport;
  fcb: boolean;
  listeners: Array<(e: UnifiedEvent) => void>;
  measurements: Record<string, number>;
  breakerStatus: string;
  settingGroup: string;
  pollTimer?: NodeJS.Timeout;
  rx: Buffer;
}

abstract class SerialIecDriverBase extends BaseRelayDriver {
  protected states = new Map<string, SerialIecState>();

  constructor(protected pointMap: PointMap, protected opts: { simulate?: boolean } = {}) {
    super();
  }

  protected state(pathId: string): SerialIecState {
    let s = this.states.get(pathId);
    if (!s) {
      s = { fcb: false, listeners: [], measurements: {}, breakerStatus: 'UNKNOWN', settingGroup: 'UNKNOWN', rx: Buffer.alloc(0) };
      this.states.set(pathId, s);
    }
    return s;
  }

  /** FT1.2 fixed-length frame (10 5A ... 16) used for link control and class polling. */
  protected buildFixedFrame(path: CommPath, functionCode: number, useFcv: boolean): Buffer {
    const s = this.state(path.pathId);
    const address = Number(path.serial?.linkAddress ?? path.addressing?.linkAddress ?? 1);
    let control = PRM | functionCode;
    if (useFcv) {
      control |= FCV;
      if (s.fcb) control |= FCB;
      s.fcb = !s.fcb;
    }
    const checksum = (control + address) & 0xff;
    return Buffer.from([0x10, control, address, checksum, 0x16]);
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate || !path.serial) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      this.startPolling(path, profile);
      return;
    }
    this.setState(path, 'CONNECTING');
    try {
      const transport = await openSerial(path.serial);
      const s = this.state(path.pathId);
      s.transport = transport;
      transport.onData((chunk) => this.onData(path, profile, chunk));
      // Reset the remote link, then begin class polling.
      transport.write(this.buildFixedFrame(path, FN_RESET_REMOTE_LINK, false));
      this.setState(path, 'CONNECTED');
      this.startPolling(path, profile);
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  async disconnect(path: CommPath): Promise<void> {
    const s = this.state(path.pathId);
    if (s.pollTimer) clearInterval(s.pollTimer);
    await s.transport?.close();
    s.transport = undefined;
    this.setState(path, 'DISCONNECTED');
  }

  private startPolling(path: CommPath, profile: RelayCommProfile) {
    const s = this.state(path.pathId);
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.pollTimer = setInterval(() => {
      if (this.opts.simulate || !s.transport) {
        this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
        return;
      }
      // Class 1 carries spontaneous events (trips), class 2 carries cyclic measurements.
      s.transport.write(this.buildFixedFrame(path, FN_REQUEST_USER_DATA_1, true));
      setTimeout(() => s.transport?.write(this.buildFixedFrame(path, FN_REQUEST_USER_DATA_2, true)), 200);
    }, path.pollIntervalMs ?? 5000);
  }

  private onData(path: CommPath, profile: RelayCommProfile, chunk: Buffer) {
    const s = this.state(path.pathId);
    s.rx = Buffer.concat([s.rx, chunk]);

    while (s.rx.length >= 5) {
      if (s.rx[0] === 0xe5) {
        // Single-byte ACK: nothing to report this cycle.
        s.rx = s.rx.subarray(1);
        continue;
      }
      if (s.rx[0] === 0x10) {
        if (s.rx.length < 5) return;
        s.rx = s.rx.subarray(5); // fixed frame response, no ASDU payload
        continue;
      }
      if (s.rx[0] !== 0x68) {
        const idx = s.rx.indexOf(0x68);
        this.noteRejected(path);
        if (idx < 0) {
          s.rx = Buffer.alloc(0);
          return;
        }
        s.rx = s.rx.subarray(idx);
        continue;
      }
      // Variable-length frame: 68 L L 68 <control> <address> <asdu...> <checksum> 16
      const length = s.rx[1];
      const total = length + 6;
      if (s.rx.length < total) return;
      const frame = s.rx.subarray(0, total);
      s.rx = s.rx.subarray(total);

      // Verify the arithmetic checksum over control+address+asdu.
      const body = frame.subarray(4, 4 + length);
      const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
      if (sum !== frame[4 + length]) {
        this.noteRejected(path);
        continue;
      }
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      this.handleAsduBytes(path, profile, body.subarray(2)); // strip control + link address
    }
  }

  protected abstract handleAsduBytes(path: CommPath, profile: RelayCommProfile, asdu: Buffer): void;

  protected emit(
    path: CommPath,
    profile: RelayCommProfile,
    p: {
      eventType: UnifiedEvent['eventType'];
      severity: UnifiedEvent['severity'];
      message: string;
      timestamp?: Date;
      protectionFunction?: ProtectionFunctionCode;
      breakerStatus?: UnifiedEvent['breakerStatus'];
      sourceReference?: string;
    }
  ) {
    const s = this.state(path.pathId);
    const event: UnifiedEvent = {
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
      sourceProtocol: this.protocol,
      message: p.message,
      synthetic: Boolean(this.opts.simulate),
      timeSyncQuality: p.timestamp ? 'MILLISECOND' : 'GATEWAY_STAMPED',
      sourcePathId: path.pathId,
      sourceReference: p.sourceReference,
    };
    s.listeners.forEach((l) => l(event));
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
      timeSyncQuality: d.timeSyncQuality,
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// IEC 60870-5-101
// ---------------------------------------------------------------------------------------------

export class Iec101Driver extends SerialIecDriverBase {
  readonly protocol: SourceProtocolV2 = 'IEC60870_5_101';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.IEC60870_5_101.capabilities;

  protected handleAsduBytes(path: CommPath, profile: RelayCommProfile, asduBytes: Buffer): void {
    let asdu;
    try {
      // -101 commonly uses smaller address fields than -104.
      asdu = decodeAsdu(asduBytes, { ioaSize: 2, cotSize: 1, caSize: 1 });
    } catch {
      this.noteRejected(path);
      return;
    }
    const s = this.state(path.pathId);
    const spontaneous = asdu.causeOfTransmission === CauseOfTransmission.SPONTANEOUS;

    for (const obj of asdu.objects) {
      const point = resolvePoint(this.pointMap, profile.pointMapProfileId, 'IEC60870_5_101', obj.ioa)
        ?? resolvePoint(this.pointMap, profile.pointMapProfileId, 'IEC60870_5_104', obj.ioa);
      if (!point) continue;
      if (obj.quality?.invalid || obj.quality?.notTopical) continue;

      if (point.kind === 'MEASUREMENT' && typeof obj.value === 'number') {
        s.measurements[point.name] = obj.value * (point.scale ?? 1);
      } else if (point.kind === 'BREAKER_POSITION') {
        const status = obj.doublePoint === 2 ? 'CLOSED' : obj.doublePoint === 1 ? 'OPEN' : 'UNKNOWN';
        if (status !== s.breakerStatus && status !== 'UNKNOWN') {
          s.breakerStatus = status;
          this.emit(path, profile, {
            eventType: 'BREAKER_STATE_CHANGE',
            severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
            breakerStatus: status as any,
            message: `Breaker ${status.toLowerCase()} on ${profile.relayCode}`,
            timestamp: obj.timestamp,
            sourceReference: `IOA ${obj.ioa}`,
          });
        }
      } else if (point.kind === 'PROTECTION_TRIP' && Boolean(obj.value) && spontaneous) {
        this.emit(path, profile, {
          eventType: 'PROTECTION_TRIP',
          severity: 'CRITICAL',
          protectionFunction: point.protectionFunction,
          message: `Protection trip (${point.name}) on ${profile.relayCode}`,
          timestamp: obj.timestamp,
          sourceReference: `IOA ${obj.ioa}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// IEC 60870-5-103
// ---------------------------------------------------------------------------------------------

export class Iec103Driver extends SerialIecDriverBase {
  readonly protocol: SourceProtocolV2 = 'IEC60870_5_103';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.IEC60870_5_103.capabilities;

  /**
   * -103 ASDU type 1 (time-tagged message) and type 2 (time-tagged with relative time) carry
   * <function type, information number, DPI, time> — the standardised protection semantics. This
   * decoder reads them directly rather than going through a point map, because the meaning is
   * defined by the standard, not by the vendor.
   */
  protected handleAsduBytes(path: CommPath, profile: RelayCommProfile, asdu: Buffer): void {
    if (asdu.length < 10) return;
    const typeId = asdu[0];
    const cot = asdu[2];
    const s = this.state(path.pathId);

    // Types 1 and 2: time-tagged protection messages.
    if (typeId === 1 || typeId === 2) {
      const functionType = asdu[4];
      const informationNumber = asdu[5];
      const dpi = asdu[6] & 0x03; // 1 = OFF, 2 = ON
      // CP32Time2a follows: ms(2), minutes(1), hours(1).
      const ms = asdu.readUInt16LE(7);
      const minutes = asdu[9] & 0x3f;
      const hours = asdu.length > 10 ? asdu[10] & 0x1f : new Date().getUTCHours();
      const ts = new Date();
      ts.setUTCHours(hours, minutes, Math.floor(ms / 1000), ms % 1000);

      // Function type 128 is the protection function group; 160/176/192 are vendor-private ranges.
      const inf = IEC103_INF[informationNumber];
      if (!inf) return;

      if (inf.kind === 'STATE' && informationNumber >= 22 && informationNumber <= 25) {
        s.settingGroup = `Group ${informationNumber - 21}`;
        return;
      }
      if (dpi !== 2) return; // only the "ON" transition is an event

      if (inf.kind === 'TRIP') {
        this.emit(path, profile, {
          eventType: 'PROTECTION_TRIP',
          severity: 'CRITICAL',
          protectionFunction: inf.fn,
          message: `${inf.name} on ${profile.relayCode} (IEC 103 INF ${informationNumber}, FUN ${functionType})`,
          timestamp: ts,
          sourceReference: `INF ${informationNumber}`,
        });
      } else if (inf.kind === 'PICKUP') {
        this.emit(path, profile, {
          eventType: 'PROTECTION_PICKUP',
          severity: 'HIGH',
          protectionFunction: inf.fn,
          message: `${inf.name} on ${profile.relayCode} (IEC 103 INF ${informationNumber})`,
          timestamp: ts,
          sourceReference: `INF ${informationNumber}`,
        });
      } else if (inf.kind === 'HEALTH') {
        this.emit(path, profile, {
          eventType: 'DEVICE_SELF_TEST_FAILED',
          severity: informationNumber === 47 ? 'HIGH' : 'MEDIUM',
          protectionFunction: inf.fn,
          message: `${inf.name} on ${profile.relayCode} (IEC 103 INF ${informationNumber})`,
          timestamp: ts,
          sourceReference: `INF ${informationNumber}`,
        });
      }
      return;
    }

    // Type 3/9: measurands I, II — cyclic analogue values.
    if (typeId === 3 || typeId === 9) {
      const count = Math.floor((asdu.length - 6) / 2);
      const names = ['current_A', 'voltage_kV', 'active_power_MW', 'reactive_power_MVAr', 'frequency_Hz'];
      for (let i = 0; i < Math.min(count, names.length); i++) {
        const raw = asdu.readInt16LE(6 + i * 2) >> 3; // 13-bit measurand, left-aligned
        s.measurements[names[i]] = raw / 4096;
      }
      return;
    }

    // Type 23: list of recorded disturbances — the relay telling us a fault record exists.
    if (typeId === 23 && cot === 31) {
      this.emit(path, profile, {
        eventType: 'DISTURBANCE_RECORD_AVAILABLE',
        severity: 'INFO',
        message: `Disturbance record available on ${profile.relayCode} (IEC 103 fault record list)`,
        sourceReference: 'ASDU 23',
      });
    }
  }

  async listDisturbanceFiles(path: CommPath, _profile: RelayCommProfile): Promise<DisturbanceFileRef[]> {
    // -103 disturbance upload is a multi-step ASDU exchange (types 24/25/26/27/28/29/31). In
    // simulator mode we report one synthetic record so the downstream pipeline is exercisable.
    if (this.opts.simulate) {
      return [{ remoteId: 'DR-103-0001', fileNames: ['DR-103-0001.CFG', 'DR-103-0001.DAT'], recordedAt: new Date().toISOString() }];
    }
    return [];
  }

  async retrieveDisturbanceFile(
    _path: CommPath,
    _profile: RelayCommProfile,
    ref: DisturbanceFileRef
  ): Promise<RetrievedDisturbanceFile[]> {
    if (!this.opts.simulate) return [];
    return ref.fileNames.map((fileName) => ({
      remoteId: ref.remoteId,
      fileName,
      content: Buffer.from(`SIMULATED IEC 60870-5-103 disturbance record ${fileName}\n`, 'utf8'),
      format: 'COMTRADE_1999' as const,
    }));
  }
}
