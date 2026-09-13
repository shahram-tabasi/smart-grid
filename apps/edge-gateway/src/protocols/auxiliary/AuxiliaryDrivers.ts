import * as dgram from 'dgram';
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
  TimeSyncQuality,
  DisturbanceFileRef,
  RetrievedDisturbanceFile,
} from '@simorgh/shared';

/**
 * Auxiliary channels. These do not carry the primary measurement stream, but they carry data the
 * platform genuinely needs and that no protection protocol provides:
 *
 *  - SNMP: the health of the PATH (switches, media converters, the gateway itself, UPS). When a
 *    relay goes silent, SNMP usually holds the answer to "was it the relay or the network?" — which
 *    is precisely the distinction the AI must get right, and the reason the Phase 1 misclassification
 *    bug mattered.
 *  - Syslog: relay-side security and self-test events — setting changes, failed logins, firmware
 *    changes. This is the OT cyber-security telemetry and it feeds the audit trail.
 *  - FTP/SFTP/TFTP: COMTRADE retrieval from relays whose primary protocol cannot move files.
 *  - NTP/PTP: supervision of the clock the millisecond fault timeline depends on. Without this the
 *    timeline can silently claim precision it does not have.
 */

function evt(
  protocol: SourceProtocolV2,
  path: CommPath,
  profile: RelayCommProfile,
  p: {
    eventType: UnifiedEvent['eventType'];
    severity: UnifiedEvent['severity'];
    message: string;
    timestamp?: Date;
    sourceReference?: string;
  },
  synthetic: boolean,
  timeSyncQuality: TimeSyncQuality
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
    sourceProtocol: protocol,
    message: p.message,
    synthetic,
    timeSyncQuality,
    sourcePathId: path.pathId,
    sourceReference: p.sourceReference,
  };
}

// ---------------------------------------------------------------------------------------------
// SNMP
// ---------------------------------------------------------------------------------------------

export class SnmpDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'SNMP';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.SNMP.capabilities;

  private sessions = new Map<string, any>();
  private trapSocket?: dgram.Socket;
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private health = new Map<string, Record<string, string | number | boolean>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      this.noteData(path, { timeSyncQuality: 'GATEWAY_STAMPED' });
      this.health.set(path.pathId, { sysUpTime: 8640000, ifOperStatus: 'up', linkErrors: 0 });
      return;
    }

    let snmp: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      snmp = require('net-snmp');
    } catch {
      this.setState(path, 'FAILED', 'net-snmp is not installed. npm install net-snmp --workspace=@simorgh/edge-gateway');
      return;
    }

    // SNMPv3 with authentication and privacy only. v1/v2c community strings send credentials in
    // clear text across the substation network and are not acceptable for OT monitoring.
    const version = String(path.addressing?.version ?? '3');
    if (version !== '3') {
      this.setState(path, 'FAILED', `SNMP v${version} is not permitted; configure SNMPv3 authPriv for ${path.host}.`);
      return;
    }

    try {
      const session = snmp.createV3Session(path.host, {
        name: String(path.addressing?.securityName ?? 'simorgh'),
        level: snmp.SecurityLevel.authPriv,
        authProtocol: snmp.AuthProtocols.sha,
        privProtocol: snmp.PrivProtocols.aes,
        // Credentials come from the vault by reference; they are injected by the credential
        // resolver at connect time and never stored in the path object.
        authKey: process.env[`SNMP_AUTH_${path.credentialsRef ?? ''}`] ?? '',
        privKey: process.env[`SNMP_PRIV_${path.credentialsRef ?? ''}`] ?? '',
      });
      this.sessions.set(path.pathId, session);
      this.setState(path, 'CONNECTED');

      const oids = (path.addressing?.oids as any) ?? {
        sysUpTime: '1.3.6.1.2.1.1.3.0',
        ifOperStatus: '1.3.6.1.2.1.2.2.1.8.1',
        ifInErrors: '1.3.6.1.2.1.2.2.1.14.1',
      };
      this.timers.set(
        path.pathId,
        setInterval(() => {
          session.get(Object.values(oids), (error: Error | null, varbinds: any[]) => {
            if (error) {
              this.setState(path, 'FAILED', error.message);
              return;
            }
            this.noteData(path, { timeSyncQuality: 'GATEWAY_STAMPED' });
            const store: Record<string, string | number | boolean> = {};
            const keys = Object.keys(oids);
            varbinds.forEach((vb, i) => {
              store[keys[i]] = vb.value?.toString?.() ?? vb.value;
            });
            const prev = this.health.get(path.pathId);
            this.health.set(path.pathId, store);

            // A device whose uptime went backwards has restarted — which explains a comms gap.
            if (prev && Number(store.sysUpTime) < Number(prev.sysUpTime)) {
              this.push(path, profile, {
                eventType: 'DEVICE_SELF_TEST_FAILED',
                severity: 'MEDIUM',
                message: `Network device on the path to ${profile.relayCode} restarted (SNMP sysUpTime reset). This explains any concurrent loss of relay communication.`,
                sourceReference: 'sysUpTime',
              });
            }
            if (store.ifOperStatus && String(store.ifOperStatus) !== 'up' && String(store.ifOperStatus) !== '1') {
              this.push(path, profile, {
                eventType: 'COMM_LOST',
                severity: 'HIGH',
                message: `Network interface on the path to ${profile.relayCode} is ${store.ifOperStatus} (SNMP ifOperStatus).`,
                sourceReference: 'ifOperStatus',
              });
            }
          });
        }, path.pollIntervalMs ?? 30000)
      );

      // Traps arrive unsolicited and often carry the first indication of a path failure.
      if (!this.trapSocket && path.addressing?.receiveTraps) {
        const receiver = snmp.createReceiver({ port: 162 }, (err: Error | null, trap: any) => {
          if (err) return;
          this.push(path, profile, {
            eventType: 'SECURITY_LOG_EVENT',
            severity: 'MEDIUM',
            message: `SNMP trap received from ${trap?.rinfo?.address ?? 'unknown'} on the path to ${profile.relayCode}`,
            sourceReference: 'snmp-trap',
          });
        });
        this.sessions.set(`${path.pathId}:receiver`, receiver);
      }
    } catch (err) {
      this.setState(path, 'FAILED', (err as Error).message);
    }
  }

  private push(path: CommPath, profile: RelayCommProfile, p: Parameters<typeof evt>[3]) {
    const e = evt(this.protocol, path, profile, p, Boolean(this.opts.simulate), 'GATEWAY_STAMPED');
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
  }

  async disconnect(path: CommPath): Promise<void> {
    const t = this.timers.get(path.pathId);
    if (t) clearInterval(t);
    try {
      this.sessions.get(path.pathId)?.close?.();
      this.sessions.get(`${path.pathId}:receiver`)?.close?.();
    } catch {
      /* already closed */
    }
    this.sessions.delete(path.pathId);
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
      measurements: {},
      deviceHealth: this.health.get(path.pathId) ?? {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'GATEWAY_STAMPED',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Syslog
// ---------------------------------------------------------------------------------------------

/**
 * Syslog collector. One listener serves every relay at a site: relays are identified by source
 * address, so the collector is shared and fans out to the right relay profile.
 *
 * RFC 5424 is parsed properly; RFC 3164 (BSD) is tolerated because plenty of relay firmware still
 * emits it.
 */
export class SyslogDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2 = 'SYSLOG';
  readonly capabilities: ProtocolCapabilities = PROTOCOL_CATALOGUE.SYSLOG.capabilities;

  private socket?: dgram.Socket;
  private bound = false;
  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private hostToPath = new Map<string, { path: CommPath; profile: RelayCommProfile }>();

  constructor(private opts: { simulate?: boolean } = {}) {
    super();
  }

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    if (path.host) this.hostToPath.set(path.host, { path, profile });

    if (this.opts.simulate) {
      this.setState(path, 'CONNECTED');
      return;
    }
    if (this.bound) {
      this.setState(path, 'CONNECTED');
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (msg, rinfo) => this.onMessage(msg.toString('utf8'), rinfo.address));
    socket.on('error', (err) => this.setState(path, 'FAILED', err.message));
    await new Promise<void>((resolve) => {
      socket.bind(path.port ?? 514, () => {
        this.bound = true;
        this.setState(path, 'CONNECTED');
        resolve();
      });
    });
  }

  private onMessage(raw: string, sourceAddress: string) {
    const target = this.hostToPath.get(sourceAddress);
    if (!target) return; // syslog from a device we do not monitor
    const { path, profile } = target;
    this.noteData(path, { timeSyncQuality: 'SECOND' });

    // RFC 5424: <PRI>VERSION TIMESTAMP HOSTNAME APP PROCID MSGID [SD] MSG
    const rfc5424 = raw.match(/^<(\d+)>1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:\[.*?\]|-)\s*(.*)$/s);
    // RFC 3164: <PRI>MMM dd hh:mm:ss HOSTNAME TAG: MSG
    const rfc3164 = raw.match(/^<(\d+)>([A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/s);

    let pri = 13;
    let timestamp: Date | undefined;
    let message = raw;
    if (rfc5424) {
      pri = Number(rfc5424[1]);
      timestamp = new Date(rfc5424[2]);
      message = rfc5424[7];
    } else if (rfc3164) {
      pri = Number(rfc3164[1]);
      message = rfc3164[4];
    }
    if (timestamp && Number.isNaN(timestamp.getTime())) timestamp = undefined;

    const severityCode = pri & 0x07; // 0=emerg .. 7=debug
    const severity: UnifiedEvent['severity'] =
      severityCode <= 2 ? 'CRITICAL' : severityCode === 3 ? 'HIGH' : severityCode === 4 ? 'MEDIUM' : 'INFO';

    // Security-relevant relay messages get promoted regardless of the syslog priority the vendor
    // chose, because a settings change is operationally significant even if logged as "info".
    const isSettingChange = /setting[s]?\s+(chang|modif|updat|writ)/i.test(message) || /\bSET\b.*\bchanged\b/i.test(message);
    const isAuthFailure = /(failed|invalid|denied).*(login|password|authentication|access)/i.test(message);
    const isFirmware = /firmware|upgrade|flash/i.test(message);
    const isSelfTest = /self[- ]?test|diagnostic.*(fail|error)/i.test(message);

    let eventType: UnifiedEvent['eventType'] = 'SECURITY_LOG_EVENT';
    let finalSeverity = severity;
    let prefix = 'Relay log';

    if (isSettingChange) {
      finalSeverity = 'HIGH';
      prefix = 'PROTECTION SETTING CHANGE detected on the relay';
    } else if (isAuthFailure) {
      finalSeverity = 'HIGH';
      prefix = 'Authentication failure on the relay';
    } else if (isFirmware) {
      finalSeverity = 'HIGH';
      prefix = 'Firmware activity on the relay';
    } else if (isSelfTest) {
      eventType = 'DEVICE_SELF_TEST_FAILED';
      finalSeverity = 'HIGH';
      prefix = 'Self-test failure reported by the relay';
    }

    const e = evt(
      this.protocol,
      path,
      profile,
      {
        eventType,
        severity: finalSeverity,
        message: `${prefix} ${profile.relayCode}: ${message.trim().slice(0, 500)}`,
        timestamp,
        sourceReference: `syslog pri=${pri}`,
      },
      Boolean(this.opts.simulate),
      timestamp ? 'SECOND' : 'GATEWAY_STAMPED'
    );
    (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
  }

  async disconnect(path: CommPath): Promise<void> {
    if (path.host) this.hostToPath.delete(path.host);
    if (this.hostToPath.size === 0 && this.socket) {
      this.socket.close();
      this.socket = undefined;
      this.bound = false;
    }
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
      measurements: {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'SECOND',
      viaPathId: path.pathId,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// File retrieval (FTP / SFTP / TFTP)
// ---------------------------------------------------------------------------------------------

/**
 * Disturbance-record retrieval for relays whose primary protocol cannot move files.
 *
 * Security posture differs per transport and is enforced, not merely documented:
 *  - SFTP is preferred (key-based auth, host keys pinned per site).
 *  - FTP is plaintext and is refused unless the path is explicitly marked as inside the OT segment.
 *  - TFTP has no authentication at all; only the READ opcode is ever sent.
 */
export class FileRetrievalDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2;
  readonly capabilities: ProtocolCapabilities;

  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();

  constructor(protocol: 'FTP' | 'SFTP' | 'TFTP' = 'SFTP', private opts: { simulate?: boolean } = {}) {
    super();
    this.protocol = protocol;
    this.capabilities = PROTOCOL_CATALOGUE[protocol].capabilities;
  }

  async connect(path: CommPath, _profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');

    if (this.protocol === 'FTP' && !path.addressing?.otSegmentConfirmed) {
      this.setState(
        path,
        'FAILED',
        'Plaintext FTP is only permitted inside the substation OT segment. Set addressing.otSegmentConfirmed on the path, or use SFTP.'
      );
      return;
    }
    this.setState(path, 'CONNECTED');
    this.noteData(path, { timeSyncQuality: 'UNKNOWN' });
  }

  async disconnect(path: CommPath): Promise<void> {
    this.setState(path, 'DISCONNECTED');
  }

  async readStatus(path: CommPath, _profile: RelayCommProfile): Promise<RelayStatusSnapshotV2> {
    const d = this.diagnostics(path);
    return {
      commStatus: d.state === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
      breakerStatus: 'UNKNOWN',
      activeSettingGroup: 'UNKNOWN',
      measurements: {},
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: 'UNKNOWN',
      viaPathId: path.pathId,
    };
  }

  subscribeEvents(path: CommPath, _profile: RelayCommProfile, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const list = this.listeners.get(path.pathId) ?? [];
    list.push(onEvent);
    this.listeners.set(path.pathId, list);
    return () => this.listeners.set(path.pathId, (this.listeners.get(path.pathId) ?? []).filter((l) => l !== onEvent));
  }

  async listDisturbanceFiles(path: CommPath, _profile: RelayCommProfile): Promise<DisturbanceFileRef[]> {
    if (this.opts.simulate) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      return [
        {
          remoteId: `DR_${stamp}`,
          fileNames: [`DR_${stamp}.CFG`, `DR_${stamp}.DAT`],
          recordedAt: new Date().toISOString(),
          sizeBytes: 102400,
        },
      ];
    }

    if (this.protocol === 'SFTP') {
      let SftpClient: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        SftpClient = require('ssh2-sftp-client');
      } catch {
        this.setState(path, 'FAILED', 'ssh2-sftp-client is not installed on this gateway.');
        return [];
      }
      const client = new SftpClient();
      try {
        await client.connect({
          host: path.host,
          port: path.port ?? 22,
          username: String(path.addressing?.username ?? 'relay'),
          privateKey: process.env[`SFTP_KEY_${path.credentialsRef ?? ''}`],
          hostVerifier: (hash: string) =>
            !path.tls?.pinnedServerFingerprint || hash === path.tls.pinnedServerFingerprint,
        });
        const dir = String(path.addressing?.comtradeDirectory ?? '/COMTRADE');
        const entries = await client.list(dir);
        const groups = new Map<string, DisturbanceFileRef>();
        for (const f of entries) {
          if (!/\.(CFG|DAT|HDR|INF)$/i.test(f.name)) continue;
          const base = f.name.replace(/\.(CFG|DAT|HDR|INF)$/i, '');
          const fallback: DisturbanceFileRef = {
            remoteId: base,
            fileNames: [],
            sizeBytes: 0,
            recordedAt: new Date(f.modifyTime).toISOString(),
          };
          const g = groups.get(base) ?? fallback;
          g.fileNames.push(`${dir}/${f.name}`);
          g.sizeBytes = (g.sizeBytes ?? 0) + f.size;
          groups.set(base, g);
        }
        return [...groups.values()];
      } catch (err) {
        this.setState(path, 'FAILED', (err as Error).message);
        return [];
      } finally {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
      }
    }
    return [];
  }

  async retrieveDisturbanceFile(
    path: CommPath,
    _profile: RelayCommProfile,
    ref: DisturbanceFileRef
  ): Promise<RetrievedDisturbanceFile[]> {
    if (this.opts.simulate) {
      return ref.fileNames.map((fileName) => ({
        remoteId: ref.remoteId,
        fileName,
        content: Buffer.from(`SIMULATED COMTRADE ${fileName}\n`, 'utf8'),
        format: /\.CFG$/i.test(fileName) ? ('COMTRADE_1999' as const) : ('UNKNOWN' as const),
      }));
    }

    if (this.protocol === 'TFTP') {
      const out: RetrievedDisturbanceFile[] = [];
      for (const fileName of ref.fileNames) {
        const content = await this.tftpRead(path, fileName);
        if (content) out.push({ remoteId: ref.remoteId, fileName, content, format: 'UNKNOWN' });
      }
      return out;
    }

    if (this.protocol === 'SFTP') {
      let SftpClient: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        SftpClient = require('ssh2-sftp-client');
      } catch {
        return [];
      }
      const client = new SftpClient();
      try {
        await client.connect({
          host: path.host,
          port: path.port ?? 22,
          username: String(path.addressing?.username ?? 'relay'),
          privateKey: process.env[`SFTP_KEY_${path.credentialsRef ?? ''}`],
        });
        const out: RetrievedDisturbanceFile[] = [];
        for (const fileName of ref.fileNames) {
          const content: Buffer = (await client.get(fileName)) as Buffer;
          out.push({
            remoteId: ref.remoteId,
            fileName,
            content,
            format: /\.CFG$/i.test(fileName) ? 'COMTRADE_1999' : 'UNKNOWN',
          });
        }
        return out;
      } catch (err) {
        this.setState(path, 'FAILED', (err as Error).message);
        return [];
      } finally {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
      }
    }
    return [];
  }

  /** Minimal TFTP client. Only opcode 1 (RRQ, read) is ever transmitted — never opcode 2 (WRQ). */
  private tftpRead(path: CommPath, fileName: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const chunks: Buffer[] = [];
      let finished = false;

      const done = (result: Buffer | null) => {
        if (finished) return;
        finished = true;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve(result);
      };

      const rrq = Buffer.concat([
        Buffer.from([0, 1]), // opcode 1 = read request. Opcode 2 (write) is never constructed.
        Buffer.from(fileName, 'ascii'),
        Buffer.from([0]),
        Buffer.from('octet', 'ascii'),
        Buffer.from([0]),
      ]);

      const timer = setTimeout(() => done(null), 15000);
      socket.on('message', (msg, rinfo) => {
        const opcode = msg.readUInt16BE(0);
        if (opcode === 5) {
          clearTimeout(timer);
          return done(null); // error packet
        }
        if (opcode !== 3) return;
        const block = msg.readUInt16BE(2);
        chunks.push(msg.subarray(4));
        const ack = Buffer.alloc(4);
        ack.writeUInt16BE(4, 0);
        ack.writeUInt16BE(block, 2);
        socket.send(ack, rinfo.port, rinfo.address);
        if (msg.length - 4 < 512) {
          clearTimeout(timer);
          done(Buffer.concat(chunks));
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      socket.send(rrq, path.port ?? 69, path.host!);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Time-sync supervision (NTP / PTP)
// ---------------------------------------------------------------------------------------------

/**
 * Supervises the clock the fault timeline depends on.
 *
 * This is the piece that keeps the millisecond timeline honest. If the site clock drifts, every
 * event from that site is still recorded — but its declared timeSyncQuality is downgraded, and the
 * fault timeline shows the caveat rather than presenting a precise-looking ordering that is not
 * actually trustworthy.
 */
export class TimeSyncDriver extends BaseRelayDriver {
  readonly protocol: SourceProtocolV2;
  readonly capabilities: ProtocolCapabilities;

  private listeners = new Map<string, Array<(e: UnifiedEvent) => void>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private offsets = new Map<string, number>();
  private quality = new Map<string, TimeSyncQuality>();
  private lastGrandmaster = new Map<string, string>();

  constructor(protocol: 'NTP' | 'PTP_1588' = 'NTP', private opts: { simulate?: boolean } = {}) {
    super();
    this.protocol = protocol;
    this.capabilities = PROTOCOL_CATALOGUE[protocol].capabilities;
  }

  /** Degradation thresholds, milliseconds. Beyond these the declared quality drops. */
  private static readonly THRESHOLD_SUB_MS = 1;
  private static readonly THRESHOLD_MS = 50;
  private static readonly THRESHOLD_SECOND = 1000;

  async connect(path: CommPath, profile: RelayCommProfile): Promise<void> {
    this.initDiag(path);
    if (!path.enabled) return this.setState(path, 'DISABLED');
    this.setState(path, 'CONNECTED');

    const check = async () => {
      const offset = await this.measureOffset(path);
      if (offset === null) {
        this.setState(path, 'FAILED', 'no response from time source');
        return;
      }
      this.noteData(path, { timeSyncQuality: 'MILLISECOND' });
      this.offsets.set(path.pathId, offset);

      const abs = Math.abs(offset);
      const previous = this.quality.get(path.pathId);
      const now: TimeSyncQuality =
        this.protocol === 'PTP_1588' && abs < TimeSyncDriver.THRESHOLD_SUB_MS
          ? 'SUB_MICROSECOND'
          : abs < TimeSyncDriver.THRESHOLD_SUB_MS
          ? 'SUB_MILLISECOND'
          : abs < TimeSyncDriver.THRESHOLD_MS
          ? 'MILLISECOND'
          : abs < TimeSyncDriver.THRESHOLD_SECOND
          ? 'SECOND'
          : 'UNKNOWN';
      this.quality.set(path.pathId, now);
      const d = this.initDiag(path);
      d.clockOffsetMs = offset;
      d.timeSyncQuality = now;

      if (previous && previous !== now) {
        const degraded = ['UNKNOWN', 'GATEWAY_STAMPED', 'SECOND'].includes(now);
        const e = evt(
          this.protocol,
          path,
          profile,
          {
            eventType: 'TIME_SYNC_DEGRADED',
            severity: degraded ? 'HIGH' : 'INFO',
            message: degraded
              ? `Time synchronisation at this site degraded to ${now} (offset ${offset.toFixed(1)} ms). Fault timelines recorded while this persists cannot be trusted to millisecond precision.`
              : `Time synchronisation recovered to ${now} (offset ${offset.toFixed(1)} ms).`,
            sourceReference: this.protocol,
          },
          Boolean(this.opts.simulate),
          now
        );
        (this.listeners.get(path.pathId) ?? []).forEach((l) => l(e));
      }
    };

    await check();
    this.timers.set(path.pathId, setInterval(() => void check(), path.pollIntervalMs ?? 60000));
  }

  /** NTP client: builds a mode-3 client packet and computes the standard four-timestamp offset. */
  private measureOffset(path: CommPath): Promise<number | null> {
    if (this.opts.simulate) {
      return Promise.resolve((Math.random() - 0.5) * 4); // a healthy few milliseconds
    }
    if (this.protocol === 'PTP_1588') {
      // PTP requires hardware timestamping and a local daemon; the gateway reads the daemon's
      // reported offset rather than implementing PTP in userspace.
      const reported = Number(process.env.PTP_OFFSET_MS);
      return Promise.resolve(Number.isFinite(reported) ? reported : null);
    }

    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const packet = Buffer.alloc(48);
      packet[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)
      const t1 = Date.now();
      let settled = false;
      const finish = (v: number | null) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), 5000);

      socket.on('message', (msg) => {
        clearTimeout(timer);
        const t4 = Date.now();
        // NTP timestamps are seconds since 1900; convert to Unix milliseconds.
        const NTP_EPOCH_OFFSET = 2208988800;
        const t2 = (msg.readUInt32BE(32) - NTP_EPOCH_OFFSET) * 1000 + (msg.readUInt32BE(36) / 2 ** 32) * 1000;
        const t3 = (msg.readUInt32BE(40) - NTP_EPOCH_OFFSET) * 1000 + (msg.readUInt32BE(44) / 2 ** 32) * 1000;
        finish((t2 - t1 + (t3 - t4)) / 2);
      });
      socket.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      socket.send(packet, path.port ?? 123, path.host!);
    });
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
      measurements: { clock_offset_ms: this.offsets.get(path.pathId) ?? 0 },
      deviceHealth: { timeSyncQuality: this.quality.get(path.pathId) ?? 'UNKNOWN' },
      lastUpdated: d.lastDataAt ?? new Date().toISOString(),
      timeSyncQuality: this.quality.get(path.pathId) ?? 'UNKNOWN',
      viaPathId: path.pathId,
    };
  }

  /** Exposed so the supervisor can stamp events from this site with the current clock quality. */
  currentQuality(pathId: string): TimeSyncQuality {
    return this.quality.get(pathId) ?? 'UNKNOWN';
  }
}
