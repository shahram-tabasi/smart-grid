import * as https from 'https';
import * as http from 'http';
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

/**
 * Modern IT / IIoT transports: OPC UA, MQTT (plain and Sparkplug B), vendor REST APIs, and
 * WebSocket streams.
 *
 * These usually terminate at the substation gateway or SCADA server rather than at the relay
 * itself, which is exactly the architecture the security model wants: the relay stays on the OT
 * segment and only the gateway is reachable from the DMZ.
 *
 * CONTROL SAFETY per transport:
 *  - REST: the driver has one request method and it hard-codes GET. There is no code path that can
 *    issue POST/PUT/PATCH/DELETE.
 *  - MQTT: subscribe-only. No publish method exists on the driver.
 *  - OPC UA: read and monitored-item subscribe only; no write service is called.
 *  - WebSocket: the socket is used receive-only; outbound frames are limited to protocol pings.
 */

// ---------------------------------------------------------------------------------------------
// Shared emit helper
// ---------------------------------------------------------------------------------------------

interface EmitParams {
  eventType: UnifiedEvent['eventType'];
  severity: UnifiedEvent['severity'];
  message: string;
  timestamp?: Date;
  protectionFunction?: UnifiedEvent['protectionFunction'];
  breakerStatus?: UnifiedEvent['breakerStatus'];
  measurements?: UnifiedEvent['measurements'];
  sourceReference?: string;
}

function buildEvent(
  protocol: SourceProtocolV2,
  path: CommPath,
  profile: RelayCommProfile,
  p: EmitParams,
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
    measurements: p.measurements,
    synthetic,
    timeSyncQuality,
    sourcePathId: path.pathId,
    sourceReference: p.sourceReference,
  };
}

// ---------------------------------------------------------------------------------------------
// OPC UA
// ---------------------------------------------------------------------------------------------

export class OpcUaDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'OPC_UA';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.OPC_UA.capabilities;

  private sessions = new Map<string, any>();
  private subs = new Map<string, any>();
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

    let opcua: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      opcua = require('node-opcua');
    } catch {
      this.setState(
        path,
        'FAILED',
        "node-opcua is not installed. Install it on gateways with OPC UA links: npm install node-opcua --workspace=@simorgh/edge-gateway"
      );
      return;
    }

    this.setState(path, 'CONNECTING');
    try {
      const endpoint = `opc.tcp://${path.host}:${path.port ?? 4840}`;
      // Signed and encrypted only. An unauthenticated OPC UA session into a substation gateway is
      // not acceptable outside simulator mode, so None/None is deliberately not offered here.
      const client = opcua.OPCUAClient.create({
        endpointMustExist: false,
        securityMode: opcua.MessageSecurityMode.SignAndEncrypt,
        securityPolicy: opcua.SecurityPolicy.Basic256Sha256,
        connectionStrategy: { initialDelay: 1000, maxRetry: 3 },
      });
      await client.connect(endpoint);
      const session = await client.createSession(
        path.credentialsRef ? { type: opcua.UserTokenType.Certificate } : { type: opcua.UserTokenType.Anonymous }
      );
      this.sessions.set(path.pathId, { client, session });
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });

      // Monitored items give change-driven updates rather than polling.
      const subscription = await session.createSubscription2({
        requestedPublishingInterval: path.pollIntervalMs ?? 1000,
        requestedMaxKeepAliveCount: 10,
        requestedLifetimeCount: 100,
        publishingEnabled: true,
        priority: 10,
      });
      this.subs.set(path.pathId, subscription);

      const nodes: Record<string, string> = (path.addressing?.nodes as any) ?? {};
      for (const [name, nodeId] of Object.entries(nodes)) {
        const item = await subscription.monitor(
          { nodeId, attributeId: opcua.AttributeIds.Value },
          { samplingInterval: 500, discardOldest: true, queueSize: 10 },
          opcua.TimestampsToReturn.Both
        );
        item.on('changed', (dataValue: any) => {
          this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
          this.onValue(path, profile, name, dataValue.value.value, dataValue.sourceTimestamp);
        });
      }
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  private onValue(path: CommPath, profile: RelayCommProfile, name: string, value: any, ts?: Date) {
    if (typeof value === 'number') {
      const store = this.values.get(path.pathId) ?? {};
      store[name] = value;
      this.values.set(path.pathId, store);
      return;
    }
    if (typeof value !== 'boolean') return;

    if (/breaker|position|xcbr/i.test(name)) {
      const status = value ? 'CLOSED' : 'OPEN';
      if (this.breaker.get(path.pathId) !== status) {
        this.breaker.set(path.pathId, status);
        this.push(path, profile, {
          eventType: 'BREAKER_STATE_CHANGE',
          severity: status === 'OPEN' ? 'HIGH' : 'MEDIUM',
          breakerStatus: status as any,
          message: `Breaker ${status.toLowerCase()} on ${profile.relayCode} (OPC UA)`,
          timestamp: ts,
          sourceReference: name,
        });
      }
    } else if (/trip/i.test(name) && value) {
      this.push(path, profile, {
        eventType: 'PROTECTION_TRIP',
        severity: 'CRITICAL',
        message: `Protection trip signalled via OPC UA node ${name} on ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: name,
      });
    } else if (/pickup|start/i.test(name) && value) {
      this.push(path, profile, {
        eventType: 'PROTECTION_PICKUP',
        severity: 'HIGH',
        message: `Protection pickup signalled via OPC UA node ${name} on ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: name,
      });
    }
  }

  private push(path: CommPath, profile: RelayCommProfile, p: EmitParams) {
    const e = buildEvent(this.protocol, path, profile, p, Boolean(this.opts.simulate), 'MILLISECOND');
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
  }

  async disconnect(path: CommPath): Promise<void> {
    const s = this.sessions.get(path.pathId);
    const sub = this.subs.get(path.pathId);
    try {
      if (sub) await sub.terminate();
      if (s) {
        await s.session.close();
        await s.client.disconnect();
      }
    } catch {
      /* already gone */
    }
    this.sessions.delete(path.pathId);
    this.subs.delete(path.pathId);
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
    if (this.opts.simulate) {
      return {
        commStatus: 'ONLINE',
        breakerStatus: 'CLOSED',
        activeSettingGroup: 'Group 1',
        measurements: { current_A: 405.1, voltage_kV: 20.05, frequency_Hz: 50.0 },
        lastUpdated: new Date().toISOString(),
        timeSyncQuality: 'MILLISECOND',
        viaPathId: path.pathId,
      };
    }
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: this.breaker.get(path.pathId) ?? 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: d.timeSyncQuality,
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// MQTT (plain + Sparkplug B)
// ---------------------------------------------------------------------------------------------

export class MqttDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2;
  readonly capabilities: ProtocolCapabilities;

  private clients = new Map<string, any>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private values = new Map<string, Record<string, number>>();
  private online = new Map<string, boolean>();

  constructor(protocol: 'MQTT' | 'MQTT_SPARKPLUG_B' = 'MQTT', private opts: { simulate?: boolean } = {}) {
    super();
    this.protocol = protocol;
    this.capabilities = PROTOCOL_CATALOGUE[protocol].capabilities;
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      return;
    }

    let mqtt: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mqtt = require('mqtt');
    } catch {
      this.setState(path, 'FAILED', 'mqtt is not installed. npm install mqtt --workspace=@simorgh/edge-gateway');
      return;
    }

    this.setState(path, 'CONNECTING');
    const port = path.port ?? 8883;
    const useTls = path.tls?.enabled !== false; // TLS by default; plaintext must be opted into
    const url = `${useTls ? 'mqtts' : 'mqtt'}://${path.host}:${port}`;

    const client = mqtt.connect(url, {
      rejectUnauthorized: path.tls?.rejectUnauthorized !== false,
      clientId: `simorgh-gw-${profile.relayCode}-${randomUUID().slice(0, 8)}`,
      reconnectPeriod: 5000,
    });
    this.clients.set(path.pathId, client);

    const topic = String(path.addressing?.topic ?? `simorgh/${profile.relayCode}/#`);
    client.on('connect', () => {
      this.setState(path, 'CONNECTED');
      // Subscribe only. This driver has no publish path at all, so it cannot be used as a command channel.
      client.subscribe(topic, { qos: 1 });
      if (this.protocol === 'MQTT_SPARKPLUG_B') {
        // Sparkplug birth/death certificates make device online state explicit rather than inferred.
        client.subscribe(`spBv1.0/+/NBIRTH/+`, { qos: 1 });
        client.subscribe(`spBv1.0/+/NDEATH/+`, { qos: 1 });
        client.subscribe(`spBv1.0/+/DDATA/+/#`, { qos: 1 });
      }
    });
    client.on('error', (err: Error) => this.setState(path, 'FAILED', err.message));
    client.on('close', () => this.setState(path, 'DISCONNECTED'));
    client.on('message', (t: string, payload: Buffer) => this.onMessage(path, profile, t, payload));
  }

  private onMessage(path: CommPath, profile: RelayCommProfile, topic: string, payload: Buffer) {
    this.noteData(path, { timeSyncQuality: 'MILLISECOND' });

    if (this.protocol === 'MQTT_SPARKPLUG_B') {
      if (/\/NDEATH\//.test(topic)) {
        this.online.set(path.pathId, false);
        this.push(path, profile, {
          eventType: 'COMM_LOST',
          severity: 'HIGH',
          message: `Sparkplug death certificate received for ${profile.relayCode} — the publisher declared itself offline.`,
          sourceReference: topic,
        });
        return;
      }
      if (/\/NBIRTH\//.test(topic)) {
        this.online.set(path.pathId, true);
        this.push(path, profile, {
          eventType: 'COMM_RESTORED',
          severity: 'INFO',
          message: `Sparkplug birth certificate received for ${profile.relayCode}.`,
          sourceReference: topic,
        });
        return;
      }
    }

    let data: any;
    try {
      data = JSON.parse(payload.toString('utf8'));
    } catch {
      this.noteRejected(path);
      return;
    }

    const store = this.values.get(path.pathId) ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number') store[k] = v;
    }
    this.values.set(path.pathId, store);

    const ts = data.timestamp ? new Date(data.timestamp) : undefined;
    if (data.trip === true || /trip/i.test(String(data.event ?? ''))) {
      this.push(path, profile, {
        eventType: 'PROTECTION_TRIP',
        severity: 'CRITICAL',
        message: `Protection trip reported via MQTT for ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: topic,
      });
    } else if (data.breakerStatus) {
      this.push(path, profile, {
        eventType: 'BREAKER_STATE_CHANGE',
        severity: data.breakerStatus === 'OPEN' ? 'HIGH' : 'MEDIUM',
        breakerStatus: data.breakerStatus,
        message: `Breaker ${String(data.breakerStatus).toLowerCase()} reported via MQTT for ${profile.relayCode}`,
        timestamp: ts,
        sourceReference: topic,
      });
    }
  }

  private push(path: CommPath, profile: RelayCommProfile, p: EmitParams) {
    const e = buildEvent(this.protocol, path, profile, p, Boolean(this.opts.simulate), 'MILLISECOND');
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
  }

  async disconnect(path: CommPath): Promise<void> {
    const c = this.clients.get(path.pathId);
    if (c) await new Promise<void>((res) => c.end(false, {}, () => res()));
    this.clients.delete(path.pathId);
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
      commStatus: d.state === 'CONNECTED' && this.online.get(path.pathId) !== false ? 'ONLINE' : d.state === 'CONNECTED' ? 'DEGRADED' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? (this.opts.simulate ? { current_A: 396.4, voltage_kV: 19.98 } : {}),
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'MILLISECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Vendor REST / HTTP API
// ---------------------------------------------------------------------------------------------

export class RestDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'REST';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.REST.capabilities;

  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private values = new Map<string, Record<string, number>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private breaker = new Map<string, string>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  /**
   * The only request method in this driver, and it hard-codes GET. There is no parameter for the
   * HTTP verb, so no caller can turn this into a write.
   */
  private get(path: CommPath, urlPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const useTls = path.tls?.enabled !== false;
      const lib = useTls ? https : http;
      const req = lib.request(
        {
          host: path.host,
          port: path.port ?? (useTls ? 443 : 80),
          path: urlPath,
          method: 'GET', // fixed, never parameterised
          rejectUnauthorized: path.tls?.rejectUnauthorized !== false,
          timeout: 8000,
          headers: { Accept: 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
              reject(e as Error);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('request timeout')));
      req.end();
    });
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    this.setState(path, 'CONNECTED');
    const interval = path.pollIntervalMs ?? 15000;
    this.timers.set(
      path.pathId,
      setInterval(() => this.poll(path, profile).catch(() => undefined), interval)
    );
    await this.poll(path, profile).catch(() => undefined);
  }

  private async poll(path: CommPath, profile: RelayCommProfile) {
    if (this.opts.simulate) {
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      this.values.set(path.pathId, { current_A: 402 + Math.random() * 10, voltage_kV: 20.02, frequency_Hz: 50.0 });
      return;
    }
    const statusPath = String(path.addressing?.statusPath ?? '/api/v1/status');
    try {
      const data = await this.get(path, statusPath);
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });

      const store: Record<string, number> = {};
      for (const [k, v] of Object.entries(data.measurements ?? data)) {
        if (typeof v === 'number') store[k] = v;
      }
      this.values.set(path.pathId, store);

      if (data.breakerStatus && this.breaker.get(path.pathId) !== data.breakerStatus) {
        this.breaker.set(path.pathId, data.breakerStatus);
        this.push(path, profile, {
          eventType: 'BREAKER_STATE_CHANGE',
          severity: data.breakerStatus === 'OPEN' ? 'HIGH' : 'MEDIUM',
          breakerStatus: data.breakerStatus,
          message: `Breaker ${String(data.breakerStatus).toLowerCase()} on ${profile.relayCode} (REST)`,
        });
      }
      for (const ev of data.events ?? []) {
        if (/trip/i.test(ev.type ?? '')) {
          this.push(path, profile, {
            eventType: 'PROTECTION_TRIP',
            severity: 'CRITICAL',
            message: `Protection trip reported by ${profile.relayCode} REST API: ${ev.description ?? ev.type}`,
            timestamp: ev.timestamp ? new Date(ev.timestamp) : undefined,
            sourceReference: ev.id,
          });
        }
      }
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  private push(path: CommPath, profile: RelayCommProfile, p: EmitParams) {
    const e = buildEvent(this.protocol, path, profile, p, Boolean(this.opts.simulate), 'MILLISECOND');
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
  }

  async disconnect(path: CommPath): Promise<void> {
    const t = this.timers.get(path.pathId);
    if (t) clearInterval(t);
    this.timers.delete(path.pathId);
    this.setState(path, 'DISCONNECTED');
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
  }

  async readStatus(path: CommPath, profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    await this.poll(path, profile).catch(() => undefined);
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: this.breaker.get(path.pathId) ?? (this.opts.simulate ? 'CLOSED' : 'UNKNOWN'),
      activeSettingGroup: this.opts.simulate ? 'Group 1' : 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'MILLISECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// WebSocket stream
// ---------------------------------------------------------------------------------------------

export class WebSocketStreamDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'WEBSOCKET';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.WEBSOCKET.capabilities;

  private sockets = new Map<string, any>();
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private values = new Map<string, Record<string, number>>();

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
    let WS: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      WS = require('ws');
    } catch {
      this.setState(path, 'FAILED', 'ws is not installed on this gateway.');
      return;
    }
    this.setState(path, 'CONNECTING');
    const useTls = path.tls?.enabled !== false;
    const url = `${useTls ? 'wss' : 'ws'}://${path.host}:${path.port ?? 443}${path.addressing?.streamPath ?? '/stream'}`;
    const socket = new WS(url, { rejectUnauthorized: path.tls?.rejectUnauthorized !== false });
    this.sockets.set(path.pathId, socket);

    socket.on('open', () => this.setState(path, 'CONNECTED'));
    socket.on('error', (err: Error) => this.setState(path, 'FAILED', err.message));
    socket.on('close', () => this.setState(path, 'DISCONNECTED'));
    socket.on('message', (raw: Buffer) => {
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      try {
        const data = JSON.parse(raw.toString('utf8'));
        const store = this.values.get(path.pathId) ?? {};
        for (const [k, v] of Object.entries(data)) if (typeof v === 'number') store[k] = v;
        this.values.set(path.pathId, store);
        if (data.trip === true) {
          const e = buildEvent(
            this.protocol,
            path,
            profile,
            {
              eventType: 'PROTECTION_TRIP',
              severity: 'CRITICAL',
              message: `Protection trip streamed from ${profile.relayCode}`,
              timestamp: data.timestamp ? new Date(data.timestamp) : undefined,
            },
            false,
            'MILLISECOND'
          );
          (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
        }
      } catch {
        this.noteRejected(path);
      }
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
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: this.values.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'MILLISECOND',
      viaPathId: path.pathId,
    };
  }
}
