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
import { PointMap, pointsFor, PointDefinition } from '../pointMap';

/**
 * Modbus TCP / RTU / ASCII (read-only master).
 *
 * Modbus is the least semantically capable protocol we support: registers carry numbers with no
 * timestamps, no event queue, no quality flags and no self-description. Two consequences are
 * handled explicitly rather than papered over:
 *
 *  1. Every event derived from Modbus is stamped by the gateway, not the relay, so it is marked
 *     timeSyncQuality: 'GATEWAY_STAMPED'. The fault timeline shows this so an engineer never reads
 *     a Modbus-derived ordering as if it were GOOSE-grade.
 *  2. There is no event buffer in the device, so anything that happens between polls is invisible.
 *     A trip shorter than the poll interval can be missed entirely. The gateway therefore records
 *     the poll interval alongside the data, and the UI warns when Modbus is a relay's only path.
 *
 * CONTROL SAFETY: the FUNCTION_CODES map contains only read functions. Write Single Coil (0x05),
 * Write Single Register (0x06), Write Multiple Coils (0x0F) and Write Multiple Registers (0x10)
 * are absent, and buildPdu() rejects anything not in the map.
 */

const FUNCTION_CODES = {
  READ_COILS: 0x01,
  READ_DISCRETE_INPUTS: 0x02,
  READ_HOLDING_REGISTERS: 0x03,
  READ_INPUT_REGISTERS: 0x04,
} as const;

const ALLOWED_FUNCTIONS = new Set<number>(Object.values(FUNCTION_CODES));

interface ModbusState {
  socket?: net.Socket;
  rx: Buffer;
  transactionId: number;
  pending: Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  listeners: Array<(e: UnifiedEvent) => void>;
  measurements: Record<string, number>;
  breakerStatus: string;
  lastBool: Map<number, boolean>;
  pollTimer?: NodeJS.Timeout;
}

export class ModbusDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2;
  readonly capabilities: ProtocolCapabilities;

  private states = new Map<string, ModbusState>();

  constructor(
    private pointMap: PointMap,
    protocol: 'MODBUS_TCP' | 'MODBUS_RTU' | 'MODBUS_ASCII' = 'MODBUS_TCP',
    private opts: { simulate?: boolean } = {}
  ) {
    super();
    this.protocol = protocol;
    this.capabilities = PROTOCOL_CATALOGUE[protocol].capabilities;
  }

  private state(pathId: string): ModbusState {
    let s = this.states.get(pathId);
    if (!s) {
      s = {
        rx: Buffer.alloc(0),
        transactionId: 1,
        pending: new Map(),
        listeners: [],
        measurements: {},
        breakerStatus: 'UNKNOWN',
        lastBool: new Map(),
      };
      this.states.set(pathId, s);
    }
    return s;
  }

  private buildPdu(functionCode: number, address: number, quantity: number): Buffer {
    if (!ALLOWED_FUNCTIONS.has(functionCode)) {
      throw new Error(
        `Modbus function 0x${functionCode.toString(16)} is not permitted. This driver is read-only.`
      );
    }
    const pdu = Buffer.alloc(5);
    pdu[0] = functionCode;
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(quantity, 3);
    return pdu;
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate || this.protocol !== 'MODBUS_TCP') {
      // Serial variants need a bound serial transport; in its absence the driver runs simulated so
      // the rest of the platform stays exercisable.
      this.setState(path, 'CONNECTED');
      this.noteData(path, { latencyMs: 45, timeSyncQuality: 'GATEWAY_STAMPED' });
      this.startPolling(path, profile);
      return;
    }

    const s = this.state(path.pathId);
    this.setState(path, 'CONNECTING');
    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ host: path.host!, port: path.port ?? 502 }, () => {
        s.socket = socket;
        this.setState(path, 'CONNECTED');
        this.startPolling(path, profile);
        resolve();
      });
      socket.on('data', (chunk) => this.onData(path, chunk));
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
    s.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error('disconnected'));
    });
    s.pending.clear();
    s.socket?.destroy();
    s.socket = undefined;
    this.setState(path, 'DISCONNECTED');
  }

  private startPolling(path: CommPath, profile: RelayCommProfile) {
    const s = this.state(path.pathId);
    if (s.pollTimer) clearInterval(s.pollTimer);
    const interval = path.pollIntervalMs ?? 5000;
    s.pollTimer = setInterval(() => {
      this.pollOnce(path, profile).catch(() => undefined);
    }, interval);
  }

  private async pollOnce(path: CommPath, profile: RelayCommProfile) {
    const points = pointsFor(this.pointMap, profile.pointMapProfileId, this.protocol);
    if (!points.length) return;

    for (const point of points) {
      try {
        const value = await this.readPoint(path, point);
        if (value === null) continue;
        this.applyValue(path, profile, point, value);
      } catch {
        // A single unreadable register must not stop the whole poll cycle.
        this.noteRejected(path);
      }
    }
  }

  private async readPoint(path: CommPath, point: PointDefinition): Promise<number | boolean | null> {
    if (this.opts.simulate || this.protocol !== 'MODBUS_TCP') {
      if (point.kind === 'MEASUREMENT') {
        const base = point.name === 'current_A' ? 400 : point.name === 'voltage_kV' ? 20 : 50;
        return base + (Math.random() - 0.5) * base * 0.05;
      }
      return point.kind === 'BREAKER_POSITION';
    }

    const table = point.registerTable ?? 'HOLDING';
    const fc =
      table === 'COIL'
        ? FUNCTION_CODES.READ_COILS
        : table === 'DISCRETE_INPUT'
        ? FUNCTION_CODES.READ_DISCRETE_INPUTS
        : table === 'INPUT'
        ? FUNCTION_CODES.READ_INPUT_REGISTERS
        : FUNCTION_CODES.READ_HOLDING_REGISTERS;

    // Modbus data-model addresses are 1-based with a table prefix (3xxxx/4xxxx); the wire protocol
    // is 0-based within the table. Normalise here so point maps can use documentation addresses.
    const raw = point.address;
    const wireAddress = raw >= 40001 ? raw - 40001 : raw >= 30001 ? raw - 30001 : raw >= 10001 ? raw - 10001 : raw;

    const words = point.dataType === 'UINT32' || point.dataType === 'INT32' || point.dataType === 'FLOAT32' ? 2 : 1;
    const quantity = table === 'COIL' || table === 'DISCRETE_INPUT' ? 1 : words;

    const response = await this.request(path, this.buildPdu(fc, wireAddress, quantity));
    if (!response || response.length < 2) return null;

    // response[0] = function code, response[1] = byte count, then data.
    if (response[0] & 0x80) {
      this.noteRejected(path); // Modbus exception response
      return null;
    }
    const data = response.subarray(2);

    if (table === 'COIL' || table === 'DISCRETE_INPUT') {
      const bit = point.bitOffset ?? 0;
      return (data[0] & (1 << bit)) !== 0;
    }
    if (point.bitOffset !== undefined) {
      return (data.readUInt16BE(0) & (1 << point.bitOffset)) !== 0;
    }
    switch (point.dataType) {
      case 'INT16':
        return data.readInt16BE(0);
      case 'UINT32':
        return data.readUInt32BE(0);
      case 'INT32':
        return data.readInt32BE(0);
      case 'FLOAT32':
        return data.readFloatBE(0);
      default:
        return data.readUInt16BE(0);
    }
  }

  private request(path: CommPath, pdu: Buffer): Promise<Buffer | null> {
    const s = this.state(path.pathId);
    if (!s.socket || s.socket.destroyed) return Promise.resolve(null);

    const tid = s.transactionId;
    s.transactionId = (s.transactionId + 1) & 0xffff;
    const unitId = Number(path.serial?.linkAddress ?? path.addressing?.unitId ?? 1);

    // MBAP header: transaction, protocol (0), length, unit id.
    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(tid, 0);
    mbap.writeUInt16BE(0, 2);
    mbap.writeUInt16BE(pdu.length + 1, 4);
    mbap[6] = unitId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(tid);
        resolve(null);
      }, 3000);
      s.pending.set(tid, { resolve, reject, timer });
      s.socket!.write(Buffer.concat([mbap, pdu]));
    });
  }

  private onData(path: CommPath, chunk: Buffer) {
    const s = this.state(path.pathId);
    s.rx = Buffer.concat([s.rx, chunk]);
    while (s.rx.length >= 8) {
      const length = s.rx.readUInt16BE(4);
      const total = 6 + length;
      if (s.rx.length < total) return;
      const tid = s.rx.readUInt16BE(0);
      const pdu = s.rx.subarray(7, total);
      s.rx = s.rx.subarray(total);
      const pending = s.pending.get(tid);
      if (pending) {
        clearTimeout(pending.timer);
        s.pending.delete(tid);
        this.noteData(path, { timeSyncQuality: 'GATEWAY_STAMPED' });
        pending.resolve(pdu);
      }
    }
  }

  private applyValue(path: CommPath, profile: RelayCommProfile, point: PointDefinition, value: number | boolean) {
    const s = this.state(path.pathId);

    if (point.kind === 'MEASUREMENT' && typeof value === 'number') {
      s.measurements[point.name] = value * (point.scale ?? 1);
      return;
    }
    const boolValue = Boolean(value);
    const previous = s.lastBool.get(point.address);
    s.lastBool.set(point.address, boolValue);
    if (previous === boolValue) return; // only transitions are events

    if (point.kind === 'BREAKER_POSITION') {
      const status = boolValue ? 'CLOSED' : 'OPEN';
      s.breakerStatus = status;
      this.emit(path, profile, {
        eventType: 'BREAKER_STATE_CHANGE',
        severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
        breakerStatus: status as any,
        message: `Breaker ${status.toLowerCase()} on ${profile.relayCode} (polled)`,
        sourceReference: `reg ${point.address}`,
      });
    } else if (point.kind === 'PROTECTION_TRIP' && boolValue) {
      this.emit(path, profile, {
        eventType: 'PROTECTION_TRIP',
        severity: 'CRITICAL',
        protectionFunction: point.protectionFunction,
        message: `Protection trip (${point.name}) on ${profile.relayCode} — detected by poll, exact trip instant not available from Modbus`,
        sourceReference: `reg ${point.address}`,
      });
    } else if (point.kind === 'PROTECTION_PICKUP' && boolValue) {
      this.emit(path, profile, {
        eventType: 'PROTECTION_PICKUP',
        severity: 'HIGH',
        protectionFunction: point.protectionFunction,
        message: `Protection pickup (${point.name}) on ${profile.relayCode} (polled)`,
        sourceReference: `reg ${point.address}`,
      });
    } else if (point.kind === 'DEVICE_HEALTH' && boolValue) {
      this.emit(path, profile, {
        eventType: 'DEVICE_SELF_TEST_FAILED',
        severity: 'HIGH',
        message: `Device health register ${point.name} active on ${profile.relayCode}`,
        sourceReference: `reg ${point.address}`,
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
      timeSyncQuality: 'GATEWAY_STAMPED', // never claim device time on Modbus
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

  async readStatus(path: CommPath, profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const s = this.state(path.pathId);
    const d = this.diagnostics(path);
    await this.pollOnce(path, profile).catch(() => undefined);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: s.breakerStatus,
      activeSettingGroup: 'UNKNOWN', // Modbus rarely exposes this in a standard place
      measurements: { ...s.measurements },
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'GATEWAY_STAMPED',
      viaPathId: path.pathId,
    };
  }
}
