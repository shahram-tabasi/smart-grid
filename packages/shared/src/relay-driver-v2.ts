import { UnifiedEvent } from './unified-event';
import { CommStatus } from './enums';
import { Unsubscribe } from './relay-driver';
import { SourceProtocolV2, TimeSyncQuality, ProtocolCapabilities } from './protocols';

/**
 * Phase 2 driver contract. Extends the Phase 1 RelayDriver with everything the real protocol
 * drivers need: credentials by reference, redundant communication paths, disturbance-file
 * retrieval, time-sync quality reporting, and connection supervision/diagnostics.
 *
 * THE SECURITY INVARIANT IS STRUCTURAL, NOT DOCUMENTARY:
 * there is no write(), setSetting(), operate(), selectBeforeOperate(), trip() or close() method on
 * this interface, and none of the capability flags describe one. A driver physically cannot expose
 * a control path through this contract. Every concrete driver additionally restricts itself at the
 * protocol level (DNP3 read function codes only, HTTP GET only, MQTT subscribe only, SEL read
 * commands only, TFTP read opcode only, and so on) so the restriction survives even if someone
 * later bypasses this interface.
 */

// ---------------------------------------------------------------------------------------------
// Endpoint description
// ---------------------------------------------------------------------------------------------

export interface SerialSettings {
  devicePath: string; // e.g. /dev/ttyS0 or COM3
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  /** Unbalanced-mode link address (IEC 60870-5-101/103) or slave/unit id (Modbus RTU, SPA-bus). */
  linkAddress?: number;
}

export interface TlsSettings {
  enabled: boolean;
  /** Reference into the credential vault for the client certificate — never the PEM itself. */
  clientCertRef?: string;
  /** Expected server certificate fingerprint, pinned per site. */
  pinnedServerFingerprint?: string;
  rejectUnauthorized: boolean;
}

/**
 * A single physical/logical way to reach one relay. A relay may have several — see
 * RelayCommProfile.paths — for redundancy (e.g. primary IEC 61850 MMS on the station bus, backup
 * IEC 60870-5-103 on serial).
 */
export interface CommPath {
  pathId: string;
  protocol: SourceProtocolV2;
  role: 'PRIMARY' | 'BACKUP' | 'AUXILIARY';
  host?: string;
  port?: number;
  serial?: SerialSettings;
  tls?: TlsSettings;
  /** Reference into the credential vault. Never a raw secret in this object. */
  credentialsRef?: string;
  /** Protocol-specific addressing: IEC 61850 logical device/node, DNP3 addresses, register map id. */
  addressing?: Record<string, string | number>;
  /** Poll interval for POLL-mode protocols, milliseconds. */
  pollIntervalMs?: number;
  /** Seconds without data before the path is declared OFFLINE. */
  supervisionTimeoutSec: number;
  enabled: boolean;
}

export interface RelayCommProfile {
  relayId: string;
  relayCode: string;
  manufacturer: string;
  model: string;
  /** Ordered by preference; the supervisor fails over down this list. */
  paths: CommPath[];
  /** Which register-map / point-map profile to apply for semantically poor protocols. */
  pointMapProfileId?: string;
}

// ---------------------------------------------------------------------------------------------
// What a driver reports back
// ---------------------------------------------------------------------------------------------

export interface RelayStatusSnapshotV2 {
  commStatus: CommStatus;
  breakerStatus: string;
  activeSettingGroup: string;
  measurements: Record<string, number>;
  /** Self-diagnostic / device-health indications the relay exposes, where the protocol supports it. */
  deviceHealth?: Record<string, string | number | boolean>;
  lastUpdated: string;
  /** How much the timestamps on this data can be trusted. */
  timeSyncQuality: TimeSyncQuality;
  /** Which path produced this snapshot — matters when a relay has redundant paths. */
  viaPathId: string;
}

/** A disturbance/oscillography record discovered on the device, before it is retrieved. */
export interface DisturbanceFileRef {
  remoteId: string;
  /** COMTRADE sets are multi-file; this lists the parts the device exposes. */
  fileNames: string[];
  recordedAt?: string;
  sizeBytes?: number;
  triggerCause?: string;
}

export interface RetrievedDisturbanceFile {
  remoteId: string;
  fileName: string;
  content: Buffer;
  /** Format as reported/detected — COMTRADE 1991/1999/2013, or a vendor binary needing conversion. */
  format: 'COMTRADE_1991' | 'COMTRADE_1999' | 'COMTRADE_2013' | 'VENDOR_BINARY' | 'UNKNOWN';
}

export interface ConnectionDiagnostics {
  pathId: string;
  protocol: SourceProtocolV2;
  state: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'FAILED' | 'DISABLED';
  since: string;
  lastDataAt?: string;
  lastErrorMessage?: string;
  consecutiveFailures: number;
  /** Round-trip time on the last successful exchange, milliseconds. */
  latencyMs?: number;
  /** Measured clock offset against the site time source, milliseconds, where measurable. */
  clockOffsetMs?: number;
  timeSyncQuality: TimeSyncQuality;
  framesReceived: number;
  framesRejected: number;
}

// Unsubscribe is shared with the Phase 1 contract. It is imported at the top of this file rather
// than redeclared or re-exported, so the barrel export in index.ts has exactly one definition of it.

// ---------------------------------------------------------------------------------------------
// The driver contract
// ---------------------------------------------------------------------------------------------

export interface RelayDriverV2 {
  readonly protocol: SourceProtocolV2;
  readonly capabilities: ProtocolCapabilities;

  /** Open the channel. Must be idempotent and must never throw for an expected offline device. */
  connect(path: CommPath, profile: RelayCommProfile): Promise<void>;
  disconnect(path: CommPath): Promise<void>;

  /** Read present state. Only meaningful for protocols whose deliveryMode includes POLL. */
  readStatus(path: CommPath, profile: RelayCommProfile): Promise<RelayStatusSnapshotV2>;

  /** Receive spontaneous/unsolicited data. No-op returning a no-op unsubscribe for pure-poll protocols. */
  subscribeEvents(
    path: CommPath,
    profile: RelayCommProfile,
    onEvent: (e: UnifiedEvent) => void
  ): Unsubscribe;

  /** List disturbance records available on the device. Only for disturbanceFiles-capable protocols. */
  listDisturbanceFiles?(path: CommPath, profile: RelayCommProfile): Promise<DisturbanceFileRef[]>;

  /** Retrieve one disturbance record. Only for disturbanceFiles-capable protocols. */
  retrieveDisturbanceFile?(
    path: CommPath,
    profile: RelayCommProfile,
    ref: DisturbanceFileRef
  ): Promise<RetrievedDisturbanceFile[]>;

  /** Current health of this channel, for the gateway health endpoint and the admin UI. */
  diagnostics(path: CommPath): ConnectionDiagnostics;
}

/**
 * Convenience base class: gives every driver consistent diagnostics bookkeeping so each concrete
 * driver only has to implement the protocol itself.
 */
export abstract class BaseRelayDriver implements RelayDriverV2 {
  abstract readonly protocol: SourceProtocolV2;
  abstract readonly capabilities: ProtocolCapabilities;

  protected diag = new Map<string, ConnectionDiagnostics>();

  protected initDiag(path: CommPath): ConnectionDiagnostics {
    const existing = this.diag.get(path.pathId);
    if (existing) return existing;
    const fresh: ConnectionDiagnostics = {
      pathId: path.pathId,
      protocol: this.protocol,
      state: path.enabled ? 'DISCONNECTED' : 'DISABLED',
      since: new Date().toISOString(),
      consecutiveFailures: 0,
      timeSyncQuality: 'UNKNOWN',
      framesReceived: 0,
      framesRejected: 0,
    };
    this.diag.set(path.pathId, fresh);
    return fresh;
  }

  protected setState(path: CommPath, state: ConnectionDiagnostics['state'], errorMessage?: string) {
    const d = this.initDiag(path);
    if (d.state !== state) {
      d.state = state;
      d.since = new Date().toISOString();
    }
    if (errorMessage) {
      d.lastErrorMessage = errorMessage;
      d.consecutiveFailures += 1;
    } else if (state === 'CONNECTED') {
      d.consecutiveFailures = 0;
      d.lastErrorMessage = undefined;
    }
  }

  protected noteData(path: CommPath, opts: { latencyMs?: number; timeSyncQuality?: TimeSyncQuality } = {}) {
    const d = this.initDiag(path);
    d.lastDataAt = new Date().toISOString();
    d.framesReceived += 1;
    if (opts.latencyMs !== undefined) d.latencyMs = opts.latencyMs;
    if (opts.timeSyncQuality) d.timeSyncQuality = opts.timeSyncQuality;
  }

  protected noteRejected(path: CommPath) {
    this.initDiag(path).framesRejected += 1;
  }

  diagnostics(path: CommPath): ConnectionDiagnostics {
    return { ...this.initDiag(path) };
  }

  abstract connect(path: CommPath, profile: RelayCommProfile): Promise<void>;
  abstract disconnect(path: CommPath): Promise<void>;
  abstract readStatus(path: CommPath, profile: RelayCommProfile): Promise<RelayStatusSnapshotV2>;

  subscribeEvents(
    _path: CommPath,
    _profile: RelayCommProfile,
    _onEvent: (e: UnifiedEvent) => void
  ): Unsubscribe {
    // Pure-poll protocols have nothing to subscribe to.
    return () => undefined;
  }
}
