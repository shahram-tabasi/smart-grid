import * as net from 'net';
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
} from '@simorgh/shared';
import { decodeAsdu, buildInterrogationAsdu, CauseOfTransmission, TypeId, DecodedAsdu } from './asdu';
import { PointMap, resolvePoint } from '../pointMap';

/**
 * IEC 60870-5-104 client (controlling station, MONITOR DIRECTION ONLY).
 *
 * Implements the real APCI layer: I-format (numbered information transfer), S-format
 * (supervisory acknowledgement) and U-format (STARTDT/STOPDT/TESTFR) frames, with the k/w
 * flow-control windows and the t0..t3 timers from the standard.
 *
 * Control safety: the only ASDU this driver ever transmits is C_IC_NA_1 station interrogation
 * (a request for data) plus the U-format supervisory frames. asdu.ts has no encoder for any
 * command type, so no control action is expressible here.
 */

const START_BYTE = 0x68;

// Standard default timers (seconds).
const T1_ACK_TIMEOUT = 15; // waiting for ack of sent I/U frame
const T2_ACK_IDLE = 10; // send S-frame if no I-frame to piggyback on
const T3_TEST_IDLE = 20; // send TESTFR after idle

interface Iec104State {
  socket?: net.Socket;
  rx: Buffer;
  /** Send sequence number (our count of I-frames sent). */
  vs: number;
  /** Receive sequence number (our count of I-frames received). */
  vr: number;
  /** Highest received sequence number the peer has acknowledged. */
  ackedVs: number;
  /** Unacknowledged received frames — drives the w-window S-frame. */
  unackedRx: number;
  started: boolean;
  timers: NodeJS.Timeout[];
  listeners: Array<(e: UnifiedEvent) => void>;
  lastMeasurements: Record<string, number>;
  breakerStatus: string;
  settingGroup: string;
}

export class Iec104Driver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'IEC60870_5_104';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.IEC60870_5_104.capabilities;

  private states = new Map<string, Iec104State>();

  constructor(private pointMap: PointMap, private opts: { simulate?: boolean } = {}) {
    super();
  }

  private state(pathId: string): Iec104State {
    let s = this.states.get(pathId);
    if (!s) {
      s = {
        rx: Buffer.alloc(0),
        vs: 0,
        vr: 0,
        ackedVs: 0,
        unackedRx: 0,
        started: false,
        timers: [],
        listeners: [],
        lastMeasurements: {},
        breakerStatus: 'UNKNOWN',
        settingGroup: 'UNKNOWN',
      };
      this.states.set(pathId, s);
    }
    return s;
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) {
      this.setState(path, 'DISABLED');
      return;
    }
    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { latencyMs: 12, timeSyncQuality: 'MILLISECOND' });
      return;
    }

    const s = this.state(path.pathId);
    this.setState(path, 'CONNECTING');

    await new Promise<void>((resolve) => {
      const socket = net.createConnection(
        { host: path.host!, port: path.port ?? 2404 },
        () => {
          s.socket = socket;
          this.setState(path, 'CONNECTED');
          // STARTDT activation — tells the station we are ready to receive data transfer.
          this.sendU(path, 0x07);
          this.startTimers(path, profile);
          resolve();
        }
      );

      socket.on('data', (chunk) => this.onData(path, profile, chunk));
      socket.on('error', (err) => {
        this.setState(path, 'FAILED', err.message);
        resolve(); // connect() must not throw for an expected-offline device
      });
      socket.on('close', () => {
        s.started = false;
        this.setState(path, 'DISCONNECTED');
        this.clearTimers(path);
      });
      socket.setTimeout(T1_ACK_TIMEOUT * 1000);
    });
  }

  async disconnect(path: CommPath): Promise<void> {
    const s = this.state(path.pathId);
    this.clearTimers(path);
    if (s.socket) {
      // STOPDT before closing, so the station knows this was orderly.
      try {
        this.sendU(path, 0x13);
      } catch {
        /* socket may already be gone */
      }
      s.socket.destroy();
      s.socket = undefined;
    }
    s.started = false;
    this.setState(path, 'DISCONNECTED');
  }

  // -------------------------------------------------------------------------------------------
  // APCI framing
  // -------------------------------------------------------------------------------------------

  private send(path: CommPath, apdu: Buffer) {
    const s = this.state(path.pathId);
    if (!s.socket || s.socket.destroyed) return;
    s.socket.write(apdu);
  }

  /** U-format: STARTDT/STOPDT/TESTFR. */
  private sendU(path: CommPath, control1: number) {
    const buf = Buffer.from([START_BYTE, 0x04, control1, 0x00, 0x00, 0x00]);
    this.send(path, buf);
  }

  /** S-format: acknowledges received I-frames up to vr. */
  private sendS(path: CommPath) {
    const s = this.state(path.pathId);
    const buf = Buffer.alloc(6);
    buf[0] = START_BYTE;
    buf[1] = 0x04;
    buf[2] = 0x01; // S-format marker
    buf[3] = 0x00;
    buf.writeUInt16LE((s.vr << 1) & 0xfffe, 4);
    this.send(path, buf);
    s.unackedRx = 0;
  }

  /** I-format: numbered information transfer. Used only to carry the interrogation request. */
  private sendI(path: CommPath, asdu: Buffer) {
    const s = this.state(path.pathId);
    const buf = Buffer.alloc(6 + asdu.length);
    buf[0] = START_BYTE;
    buf[1] = 4 + asdu.length;
    buf.writeUInt16LE((s.vs << 1) & 0xfffe, 2);
    buf.writeUInt16LE((s.vr << 1) & 0xfffe, 4);
    asdu.copy(buf, 6);
    this.send(path, buf);
    s.vs = (s.vs + 1) & 0x7fff;
  }

  private onData(path: CommPath, profile: RelayCommProfile, chunk: Buffer) {
    const s = this.state(path.pathId);
    s.rx = Buffer.concat([s.rx, chunk]);

    // An APDU is: 0x68, length, then `length` bytes.
    while (s.rx.length >= 2) {
      if (s.rx[0] !== START_BYTE) {
        // Resynchronise: drop bytes until a plausible start appears.
        const idx = s.rx.indexOf(START_BYTE);
        this.noteRejected(path);
        if (idx < 0) {
          s.rx = Buffer.alloc(0);
          return;
        }
        s.rx = s.rx.subarray(idx);
        continue;
      }
      const len = s.rx[1];
      if (s.rx.length < len + 2) return; // wait for the rest
      const apdu = s.rx.subarray(2, len + 2);
      s.rx = s.rx.subarray(len + 2);
      this.handleApdu(path, profile, apdu);
    }
  }

  private handleApdu(path: CommPath, profile: RelayCommProfile, apdu: Buffer) {
    const s = this.state(path.pathId);
    const c1 = apdu[0];

    if ((c1 & 0x01) === 0) {
      // I-format: control field carries send/receive sequence numbers, then the ASDU.
      const recvSeq = apdu.readUInt16LE(0) >> 1;
      s.vr = (recvSeq + 1) & 0x7fff;
      s.ackedVs = apdu.readUInt16LE(2) >> 1;
      s.unackedRx += 1;
      const asduBuf = apdu.subarray(4);
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      try {
        const asdu = decodeAsdu(asduBuf, this.addressSizes(path));
        this.handleAsdu(path, profile, asdu);
      } catch {
        this.noteRejected(path);
      }
      // Acknowledge once the w-window is reached (w is conventionally 8).
      if (s.unackedRx >= 8) this.sendS(path);
    } else if ((c1 & 0x03) === 0x01) {
      // S-format: the station acknowledging our frames.
      s.ackedVs = apdu.readUInt16LE(2) >> 1;
    } else {
      // U-format.
      if (c1 & 0x08) {
        // STARTDT confirmation — data transfer is now active; ask for the full picture.
        s.started = true;
        const ca = Number(path.addressing?.commonAddress ?? 1);
        this.sendI(path, buildInterrogationAsdu(ca, this.addressSizes(path)));
      }
      if (c1 & 0x40) this.sendU(path, 0x80); // TESTFR act -> con
    }
  }

  private addressSizes(path: CommPath) {
    return {
      ioaSize: (Number(path.addressing?.ioaSize ?? 3) as 1 | 2 | 3),
      cotSize: (Number(path.addressing?.cotSize ?? 2) as 1 | 2),
      caSize: (Number(path.addressing?.caSize ?? 2) as 1 | 2),
    };
  }

  // -------------------------------------------------------------------------------------------
  // ASDU -> UnifiedEvent
  // -------------------------------------------------------------------------------------------

  private handleAsdu(path: CommPath, profile: RelayCommProfile, asdu: DecodedAsdu) {
    const spontaneous = asdu.causeOfTransmission === CauseOfTransmission.SPONTANEOUS;
    const s = this.state(path.pathId);

    for (const obj of asdu.objects) {
      const point = resolvePoint(this.pointMap, profile.pointMapProfileId, 'IEC60870_5_104', obj.ioa);
      // A point with no mapping is still counted, but not turned into a semantic event — guessing
      // what an unmapped IOA means is exactly how monitoring systems produce false trips.
      if (!point) continue;

      const timestamp = obj.timestamp ?? new Date();
      // Quality bits matter: an invalid/non-topical value must not raise a protection event.
      const qualityBad = obj.quality?.invalid || obj.quality?.notTopical;

      if (point.kind === 'MEASUREMENT' && typeof obj.value === 'number') {
        const scaled = obj.value * (point.scale ?? 1);
        s.lastMeasurements[point.name] = scaled;
        if (spontaneous && !qualityBad) {
          this.emit(path, profile, {
            eventType: 'MEASUREMENT',
            severity: 'INFO',
            message: `${point.name} = ${scaled.toFixed(2)}${point.unit ?? ''}`,
            timestamp,
            measurements: { [point.name]: scaled },
            sourceReference: `IOA ${obj.ioa}`,
          });
        }
      } else if (point.kind === 'BREAKER_POSITION') {
        const closed = obj.doublePoint !== undefined ? obj.doublePoint === 2 : Boolean(obj.value);
        const newStatus = obj.doublePoint === 0 || obj.doublePoint === 3 ? 'UNKNOWN' : closed ? 'CLOSED' : 'OPEN';
        const changed = newStatus !== s.breakerStatus;
        s.breakerStatus = newStatus;
        if (changed && !qualityBad) {
          this.emit(path, profile, {
            eventType: 'BREAKER_STATE_CHANGE',
            severity: newStatus === 'OPEN' ? 'HIGH' : 'MEDIUM',
            breakerStatus: newStatus as any,
            message: `Breaker ${newStatus.toLowerCase()} reported on ${profile.relayCode}`,
            timestamp,
            sourceReference: `IOA ${obj.ioa}`,
          });
        }
      } else if (point.kind === 'PROTECTION_TRIP' && Boolean(obj.value) && !qualityBad) {
        this.emit(path, profile, {
          eventType: 'PROTECTION_TRIP',
          severity: 'CRITICAL',
          protectionFunction: point.protectionFunction,
          message: `Protection trip (${point.name}) on ${profile.relayCode}`,
          timestamp,
          sourceReference: `IOA ${obj.ioa}`,
        });
      } else if (point.kind === 'PROTECTION_PICKUP' && Boolean(obj.value) && !qualityBad) {
        this.emit(path, profile, {
          eventType: 'PROTECTION_PICKUP',
          severity: 'HIGH',
          protectionFunction: point.protectionFunction,
          message: `Protection pickup (${point.name}) on ${profile.relayCode}`,
          timestamp,
          sourceReference: `IOA ${obj.ioa}`,
        });
      } else if (point.kind === 'DEVICE_HEALTH' && Boolean(obj.value)) {
        this.emit(path, profile, {
          eventType: 'DEVICE_SELF_TEST_FAILED',
          severity: 'HIGH',
          message: `Device self-check indication ${point.name} active on ${profile.relayCode}`,
          timestamp,
          sourceReference: `IOA ${obj.ioa}`,
        });
      }
    }

    // A protection-equipment event type carries its own semantics regardless of point mapping.
    if (asdu.typeId === TypeId.M_EP_TD_1) {
      for (const obj of asdu.objects) {
        if (obj.protectionEvent && obj.protectionEvent.state === 2) {
          this.emit(path, profile, {
            eventType: 'PROTECTION_TRIP',
            severity: 'CRITICAL',
            message: `Protection equipment event on ${profile.relayCode} (elapsed ${obj.protectionEvent.elapsedMs} ms)`,
            timestamp: obj.timestamp ?? new Date(),
            sourceReference: `M_EP_TD_1 IOA ${obj.ioa}`,
          });
        }
      }
    }
  }

  private emit(
    path: CommPath,
    profile: RelayCommProfile,
    // Omit the UnifiedEvent fields this helper fills in itself, and re-declare `timestamp` as a
    // Date — intersecting with Partial<UnifiedEvent> directly would produce `string & Date`.
    partial: Omit<Partial<UnifiedEvent>, 'timestamp' | 'eventType' | 'severity' | 'message'> & {
      eventType: UnifiedEvent['eventType'];
      severity: UnifiedEvent['severity'];
      message: string;
      timestamp: Date;
    }
  ) {
    const s = this.state(path.pathId);
    const event: UnifiedEvent = {
      eventId: randomUUID(),
      timestamp: partial.timestamp.toISOString(),
      projectId: '',
      provinceId: '',
      cityId: '',
      relayId: profile.relayId,
      eventType: partial.eventType,
      severity: partial.severity,
      protectionFunction: partial.protectionFunction,
      breakerStatus: partial.breakerStatus,
      sourceProtocol: this.protocol,
      message: partial.message,
      measurements: partial.measurements,
      synthetic: Boolean(this.opts.simulate),
      // -104 carries CP56Time2a, so millisecond trust is justified — but only when the station
      // actually time-tagged the object. Untagged objects fall back to gateway stamping.
      timeSyncQuality: partial.timestamp ? 'MILLISECOND' : 'GATEWAY_STAMPED',
      sourcePathId: path.pathId,
      sourceReference: partial.sourceReference,
    };
    for (const l of s.listeners) l(event);
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const s = this.state(path.pathId);
    s.listeners.push(onEvent);
    return () => {
      s.listeners = s.listeners.filter((l) => l !== onEvent);
    };
  }

  async readStatus(path: CommPath, profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const s = this.state(path.pathId);
    const d = this.diagnostics(path);

    if (this.opts.simulate) {
      return {
        commStatus: 'ONLINE',
        breakerStatus: 'CLOSED',
        activeSettingGroup: 'Group 1',
        measurements: { current_A: 412.5, voltage_kV: 20.1, frequency_Hz: 50.01 },
        lastUpdated: new Date().toISOString(),
        timeSyncQuality: 'MILLISECOND',
        viaPathId: path.pathId,
      };
    }

    // Re-interrogate so the snapshot reflects present state rather than the last spontaneous update.
    if (s.started) {
      const ca = Number(path.addressing?.commonAddress ?? 1);
      this.sendI(path, buildInterrogationAsdu(ca, this.addressSizes(path)));
    }

    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : d.state === 'FAILED' ? 'OFFLINE' : 'UNKNOWN',
      breakerStatus: s.breakerStatus,
      activeSettingGroup: s.settingGroup,
      measurements: { ...s.lastMeasurements },
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: d.timeSyncQuality,
      viaPathId: path.pathId,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------------------------

  private startTimers(path: CommPath, _profile: RelayCommProfile) {
    const s = this.state(path.pathId);
    this.clearTimers(path);

    // t2: acknowledge outstanding received frames even if we have nothing to send.
    s.timers.push(
      setInterval(() => {
        if (s.unackedRx > 0) this.sendS(path);
      }, T2_ACK_IDLE * 1000)
    );

    // t3: keep the connection provably alive during quiet periods. A station that stops answering
    // TESTFR is how we learn a link died without the TCP socket noticing.
    s.timers.push(
      setInterval(() => {
        if (s.socket && !s.socket.destroyed) this.sendU(path, 0x43); // TESTFR act
      }, T3_TEST_IDLE * 1000)
    );
  }

  private clearTimers(path: CommPath) {
    const s = this.state(path.pathId);
    s.timers.forEach((t) => clearInterval(t));
    s.timers = [];
  }
}
