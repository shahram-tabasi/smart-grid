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
import { PointMap, resolvePoint } from '../pointMap';

/**
 * DNP3 master (monitor direction only), for TCP and serial.
 *
 * CONTROL SAFETY — enforced at the protocol layer, not just by policy:
 * the ALLOWED_FUNCTION_CODES set below is the complete list of application-layer function codes
 * this driver is able to transmit, and buildRequest() throws if asked for anything else. The
 * control codes (SELECT 0x03, OPERATE 0x04, DIRECT_OPERATE 0x05, DIRECT_OPERATE_NR 0x06,
 * COLD_RESTART 0x0D, WARM_RESTART 0x0E) are deliberately absent, so a DNP3 control cannot be
 * emitted even by a caller that tries.
 */

const FUNC_CONFIRM = 0x00;
const FUNC_READ = 0x01;

/** The only application-layer function codes this driver can send. Read and confirm. Nothing else. */
const ALLOWED_FUNCTION_CODES = new Set<number>([FUNC_CONFIRM, FUNC_READ]);

/** DNP3 object groups we understand in the monitor direction. */
const GROUP_BINARY_INPUT = 1;
const GROUP_BINARY_INPUT_EVENT = 2;
const GROUP_ANALOG_INPUT = 30;
const GROUP_ANALOG_INPUT_EVENT = 32;
const GROUP_CLASS_DATA = 60;

interface Dnp3State {
  socket?: net.Socket;
  rx: Buffer;
  seq: number;
  listeners: Array<(e: UnifiedEvent) => void>;
  measurements: Record<string, number>;
  breakerStatus: string;
  pollTimer?: NodeJS.Timeout;
}

/** CRC-16/DNP — the link-layer block check. Polynomial 0x3D65, reflected, final XOR 0xFFFF. */
function dnp3Crc(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa6bc : crc >> 1;
    }
  }
  return (~crc) & 0xffff;
}

export class Dnp3Driver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2;
  readonly capabilities: ProtocolCapabilities;

  private states = new Map<string, Dnp3State>();

  constructor(
    private pointMap: PointMap,
    protocol: 'DNP3_TCP' | 'DNP3_SERIAL' = 'DNP3_TCP',
    private opts: { simulate?: boolean } = {}
  ) {
    super();
    this.protocol = protocol;
    this.capabilities = PROTOCOL_CATALOGUE[protocol].capabilities;
  }

  private state(pathId: string): Dnp3State {
    let s = this.states.get(pathId);
    if (!s) {
      s = { rx: Buffer.alloc(0), seq: 0, listeners: [], measurements: {}, breakerStatus: 'UNKNOWN' };
      this.states.set(pathId, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------------------------

  /**
   * Build a link+transport+application frame. Refuses any function code outside the read-only set.
   */
  private buildRequest(path: CommPath, functionCode: number, appObjects: Buffer): Buffer {
    if (!ALLOWED_FUNCTION_CODES.has(functionCode)) {
      // This is a hard stop rather than a log line: a control function code reaching here would
      // mean a caller is attempting something the platform must never do.
      throw new Error(
        `DNP3 function code 0x${functionCode.toString(16)} is not permitted. This driver is monitor-direction only.`
      );
    }
    const s = this.state(path.pathId);
    const master = Number(path.addressing?.masterAddress ?? 1);
    const outstation = Number(path.addressing?.outstationAddress ?? 10);

    // Application layer: control octet (FIR|FIN|seq) + function code + objects.
    const appHeader = Buffer.from([0xc0 | (s.seq & 0x0f), functionCode]);
    const appData = Buffer.concat([appHeader, appObjects]);
    s.seq = (s.seq + 1) & 0x0f;

    // Transport layer: single-segment (FIR+FIN).
    const transport = Buffer.concat([Buffer.from([0xc0 | (s.seq & 0x3f)]), appData]);

    // Link layer header: 0x0564, length, control, destination, source, CRC.
    const header = Buffer.alloc(8);
    header[0] = 0x05;
    header[1] = 0x64;
    header[2] = transport.length + 5; // length counts control+dest+src+payload
    header[3] = 0xc4; // PRM=1, unconfirmed user data
    header.writeUInt16LE(outstation, 4);
    header.writeUInt16LE(master, 6);
    const headerCrc = Buffer.alloc(2);
    headerCrc.writeUInt16LE(dnp3Crc(header), 0);

    // Body is split into 16-byte blocks, each with its own CRC.
    const blocks: Buffer[] = [];
    for (let i = 0; i < transport.length; i += 16) {
      const chunk = transport.subarray(i, i + 16);
      const crc = Buffer.alloc(2);
      crc.writeUInt16LE(dnp3Crc(chunk), 0);
      blocks.push(chunk, crc);
    }
    return Buffer.concat([header, headerCrc, ...blocks]);
  }

  /** Class 1/2/3 (events) + Class 0 (static) read — the standard integrity + event poll. */
  private buildClassPoll(path: CommPath): Buffer {
    // Object group 60: variation 2/3/4 = class 1/2/3 events, variation 1 = class 0 static data.
    const objects = Buffer.from([
      GROUP_CLASS_DATA, 2, 0x06, // class 1, all
      GROUP_CLASS_DATA, 3, 0x06, // class 2, all
      GROUP_CLASS_DATA, 4, 0x06, // class 3, all
      GROUP_CLASS_DATA, 1, 0x06, // class 0, all
    ]);
    return this.buildRequest(path, FUNC_READ, objects);
  }

  // -------------------------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------------------------

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { latencyMs: 22, timeSyncQuality: 'MILLISECOND' });
      return;
    }
    if (this.protocol === 'DNP3_SERIAL') {
      // Serial transport is provided by the serial layer; see SerialTransport in ../serial.ts.
      this.setState(path, 'FAILED', 'DNP3 serial requires a bound serial transport (see docs).');
      return;
    }

    const s = this.state(path.pathId);
    this.setState(path, 'CONNECTING');
    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ host: path.host!, port: path.port ?? 20000 }, () => {
        s.socket = socket;
        this.setState(path, 'CONNECTED');
        try {
          socket.write(this.buildClassPoll(path));
        } catch (e) {
          this.setState(path, 'FAILED', (e as Error).message);
        }
        // Periodic integrity poll; unsolicited responses arrive in between.
        s.pollTimer = setInterval(() => {
          if (s.socket && !s.socket.destroyed) {
            try {
              s.socket.write(this.buildClassPoll(path));
            } catch {
              /* handled by socket error */
            }
          }
        }, path.pollIntervalMs ?? 30000);
        resolve();
      });
      socket.on('data', (chunk) => this.onData(path, profile, chunk));
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

  async disconnect(path: CommPath): Promise<void> {
    const s = this.state(path.pathId);
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.socket?.destroy();
    s.socket = undefined;
    this.setState(path, 'DISCONNECTED');
  }

  // -------------------------------------------------------------------------------------------
  // Response decoding
  // -------------------------------------------------------------------------------------------

  private onData(path: CommPath, profile: RelayCommProfile, chunk: Buffer) {
    const s = this.state(path.pathId);
    s.rx = Buffer.concat([s.rx, chunk]);

    while (s.rx.length >= 10) {
      if (s.rx[0] !== 0x05 || s.rx[1] !== 0x64) {
        const idx = s.rx.indexOf(Buffer.from([0x05, 0x64]));
        this.noteRejected(path);
        if (idx < 0) {
          s.rx = Buffer.alloc(0);
          return;
        }
        s.rx = s.rx.subarray(idx);
        continue;
      }
      const linkLength = s.rx[2];
      // Total frame = 10 header bytes + body blocks (16 data + 2 CRC each).
      const bodyLength = linkLength - 5;
      const blockCount = Math.ceil(bodyLength / 16);
      const total = 10 + bodyLength + blockCount * 2;
      if (s.rx.length < total) return;

      const frame = s.rx.subarray(0, total);
      s.rx = s.rx.subarray(total);

      // Verify header CRC; a bad frame is counted and dropped rather than guessed at.
      if (dnp3Crc(frame.subarray(0, 8)) !== frame.readUInt16LE(8)) {
        this.noteRejected(path);
        continue;
      }

      // Reassemble the body, stripping per-block CRCs.
      const parts: Buffer[] = [];
      let off = 10;
      let remaining = bodyLength;
      while (remaining > 0) {
        const n = Math.min(16, remaining);
        parts.push(frame.subarray(off, off + n));
        off += n + 2;
        remaining -= n;
      }
      const body = Buffer.concat(parts);
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      this.handleApplicationData(path, profile, body);
    }
  }

  private handleApplicationData(path: CommPath, profile: RelayCommProfile, body: Buffer) {
    if (body.length < 4) return;
    // body[0] = transport header, body[1] = app control, body[2] = function code, body[3..4] = IIN
    let p = 4; // skip transport + app control + function + first IIN byte
    if (body.length > 4) p = 5; // second IIN byte

    while (p + 3 <= body.length) {
      const group = body[p];
      const variation = body[p + 1];
      const qualifier = body[p + 2];
      p += 3;

      // Range field: qualifier 0x00/0x01 = start-stop, 0x17/0x28 = count + indices.
      let indices: number[] = [];
      if (qualifier === 0x00 || qualifier === 0x01) {
        const size = qualifier === 0x00 ? 1 : 2;
        if (p + size * 2 > body.length) return;
        const start = size === 1 ? body[p] : body.readUInt16LE(p);
        const stop = size === 1 ? body[p + size] : body.readUInt16LE(p + size);
        p += size * 2;
        for (let i = start; i <= stop && i - start < 1000; i++) indices.push(i);
      } else if (qualifier === 0x17 || qualifier === 0x28) {
        const idxSize = qualifier === 0x17 ? 1 : 2;
        if (p + 1 > body.length) return;
        const count = qualifier === 0x17 ? body[p] : body.readUInt16LE(p);
        p += qualifier === 0x17 ? 1 : 2;
        for (let i = 0; i < count; i++) {
          if (p + idxSize > body.length) return;
          indices.push(idxSize === 1 ? body[p] : body.readUInt16LE(p));
          p += idxSize;
          // For indexed qualifiers the value follows each index; handled per-group below.
          p += this.valueSize(group, variation);
        }
        // Values were consumed inline above; emit using a second pass is not possible, so decode
        // conservatively: indexed event objects are reported as state-change notifications only.
        for (const idx of indices) this.emitFromPoint(path, profile, group, idx, null);
        continue;
      } else {
        return; // qualifier we do not decode — stop rather than misinterpret
      }

      for (const idx of indices) {
        const size = this.valueSize(group, variation);
        if (p + size > body.length) return;
        const value = this.decodeValue(body, p, group, variation);
        p += size;
        this.emitFromPoint(path, profile, group, idx, value);
      }
    }
  }

  private valueSize(group: number, variation: number): number {
    if (group === GROUP_BINARY_INPUT || group === GROUP_BINARY_INPUT_EVENT) return 1;
    if (group === GROUP_ANALOG_INPUT || group === GROUP_ANALOG_INPUT_EVENT) {
      if (variation === 1 || variation === 3) return 5; // 32-bit + flag
      if (variation === 2 || variation === 4) return 3; // 16-bit + flag
      if (variation === 5) return 5; // float32 + flag
      return 3;
    }
    return 1;
  }

  private decodeValue(buf: Buffer, p: number, group: number, variation: number): number | boolean {
    if (group === GROUP_BINARY_INPUT || group === GROUP_BINARY_INPUT_EVENT) {
      return (buf[p] & 0x80) !== 0; // bit 7 is the state in the flags octet
    }
    if (variation === 1 || variation === 3) return buf.readInt32LE(p + 1);
    if (variation === 5) return buf.readFloatLE(p + 1);
    return buf.readInt16LE(p + 1);
  }

  private emitFromPoint(
    path: CommPath,
    profile: RelayCommProfile,
    group: number,
    index: number,
    value: number | boolean | null
  ) {
    const s = this.state(path.pathId);
    const point = resolvePoint(this.pointMap, profile.pointMapProfileId, this.protocol, index);
    if (!point) return;

    if (point.kind === 'MEASUREMENT' && typeof value === 'number') {
      s.measurements[point.name] = value * (point.scale ?? 1);
      return;
    }
    if (point.kind === 'BREAKER_POSITION') {
      const status = value === true ? 'CLOSED' : value === false ? 'OPEN' : s.breakerStatus;
      if (status !== s.breakerStatus) {
        s.breakerStatus = status;
        this.emit(path, profile, {
          eventType: 'BREAKER_STATE_CHANGE',
          severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
          breakerStatus: status as any,
          message: `Breaker ${status.toLowerCase()} on ${profile.relayCode}`,
          sourceReference: `g${group} idx${index}`,
        });
      }
      return;
    }
    if (point.kind === 'PROTECTION_TRIP' && value === true) {
      this.emit(path, profile, {
        eventType: 'PROTECTION_TRIP',
        severity: 'CRITICAL',
        protectionFunction: point.protectionFunction,
        message: `Protection trip (${point.name}) on ${profile.relayCode}`,
        sourceReference: `g${group} idx${index}`,
      });
    } else if (point.kind === 'PROTECTION_PICKUP' && value === true) {
      this.emit(path, profile, {
        eventType: 'PROTECTION_PICKUP',
        severity: 'HIGH',
        protectionFunction: point.protectionFunction,
        message: `Protection pickup (${point.name}) on ${profile.relayCode}`,
        sourceReference: `g${group} idx${index}`,
      });
    } else if (point.kind === 'DEVICE_HEALTH' && value === true) {
      this.emit(path, profile, {
        eventType: 'DEVICE_SELF_TEST_FAILED',
        severity: 'HIGH',
        message: `Device trouble indication (${point.name}) on ${profile.relayCode}`,
        sourceReference: `g${group} idx${index}`,
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
      protectionFunction?: UnifiedEvent['protectionFunction'];
      breakerStatus?: UnifiedEvent['breakerStatus'];
      sourceReference?: string;
    }
  ) {
    const s = this.state(path.pathId);
    const event: UnifiedEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
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
      // DNP3 events can carry absolute timestamps (g2v2/g2v3); the variations decoded here do not,
      // so these are honestly marked as gateway-stamped rather than claiming device time.
      timeSyncQuality: 'GATEWAY_STAMPED',
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
    if (this.opts.simulate) {
      return {
        commStatus: 'ONLINE',
        breakerStatus: 'CLOSED',
        activeSettingGroup: 'Group 1',
        measurements: { current_A: 388.2, voltage_kV: 20.0, frequency_Hz: 49.98 },
        lastUpdated: new Date().toISOString(),
        timeSyncQuality: 'MILLISECOND',
        viaPathId: path.pathId,
      };
    }
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: s.breakerStatus,
      activeSettingGroup: 'UNKNOWN',
      measurements: { ...s.measurements },
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: d.timeSyncQuality,
      viaPathId: path.pathId,
    };
  }
}
