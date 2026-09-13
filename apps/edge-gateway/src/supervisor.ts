import { EventEmitter } from 'events';
import {
  RelayCommProfile,
  CommPath,
  UnifiedEvent,
  ConnectionDiagnostics,
  RelayStatusSnapshotV2,
  PROTOCOL_CATALOGUE,
  TIME_SYNC_TRUST_RANK,
  TimeSyncQuality,
} from '@simorgh/shared';
import { DriverRegistry } from './protocols/registry';

/**
 * The connection supervisor.
 *
 * A relay in a real substation frequently has more than one way to reach it — an IEC 61850 station
 * bus path plus a serial IEC 60870-5-103 backup, say, or MMS for data plus GOOSE for speed plus
 * SFTP for disturbance files. The supervisor owns that fan-out and handles the three problems it
 * creates:
 *
 *  1. FAILOVER. Paths are ordered PRIMARY -> BACKUP. If the primary goes quiet past its supervision
 *     timeout, the supervisor promotes the next path and raises COMM_LOST for the failed one. When
 *     the primary recovers it is demoted back, because the primary is normally the higher-quality
 *     source.
 *
 *  2. DUPLICATE EVENTS. The same physical trip can arrive on GOOSE (4 ms), MMS (100 ms) and the
 *     -103 serial backup (1.5 s). Reporting three trips for one event would be actively harmful in
 *     a control room. The supervisor de-duplicates within a correlation window and keeps the copy
 *     from the most trustworthy clock — that is what TIME_SYNC_TRUST_RANK is for.
 *
 *  3. HONEST TIMESTAMPS. The surviving copy keeps the best available timeSyncQuality, so the fault
 *     timeline shows the precision it actually has rather than the precision of the slowest path.
 */

export interface SupervisorOptions {
  registry: DriverRegistry;
  /** Window within which identical events from different paths are treated as one. */
  deduplicationWindowMs?: number;
  /** How often to check path liveness. */
  supervisionIntervalMs?: number;
}

interface ManagedRelay {
  profile: RelayCommProfile;
  activePathId?: string;
  unsubscribes: Array<() => void>;
  lastEventKeys: Map<string, { at: number; event: UnifiedEvent }>;
}

export class ConnectionSupervisor extends EventEmitter {
  private relays = new Map<string, ManagedRelay>();
  private timer?: NodeJS.Timeout;
  private readonly dedupWindowMs: number;
  private readonly supervisionIntervalMs: number;

  constructor(private options: SupervisorOptions) {
    super();
    this.dedupWindowMs = options.deduplicationWindowMs ?? 2500;
    this.supervisionIntervalMs = options.supervisionIntervalMs ?? 10000;
  }

  /** Emits 'event' (UnifiedEvent) and 'diagnostics' (ConnectionDiagnostics[]). */
  async addRelay(profile: RelayCommProfile): Promise<string[]> {
    const problems: string[] = [];
    const managed: ManagedRelay = { profile, unsubscribes: [], lastEventKeys: new Map() };
    this.relays.set(profile.relayId, managed);

    const ordered = [...profile.paths].sort((a, b) => this.rolePriority(a) - this.rolePriority(b));
    for (const path of ordered) {
      problems.push(...DriverRegistry.validatePath(path, profile));
      if (!path.enabled) continue;

      const driver = this.options.registry.get(path.protocol);
      await driver.connect(path, profile);

      const unsub = driver.subscribeEvents(path, profile, (event) => this.onEvent(profile, path, event));
      managed.unsubscribes.push(unsub);

      const diag = driver.diagnostics(path);
      if (diag.state === 'CONNECTED' && !managed.activePathId && path.role !== 'AUXILIARY') {
        managed.activePathId = path.pathId;
      }
    }
    return problems;
  }

  private rolePriority(p: CommPath): number {
    return p.role === 'PRIMARY' ? 0 : p.role === 'BACKUP' ? 1 : 2;
  }

  /**
   * De-duplicate, then republish. The key deliberately excludes the timestamp and the path: two
   * reports of the same trip on different channels arrive milliseconds to seconds apart and must
   * collapse to one.
   */
  private onEvent(profile: RelayCommProfile, path: CommPath, event: UnifiedEvent) {
    const managed = this.relays.get(profile.relayId);
    if (!managed) return;

    // AUXILIARY paths (SNMP, syslog, time sync) describe the path or the device, not the primary
    // protection state, so they are never de-duplicated against protection events.
    const isAuxiliary = path.role === 'AUXILIARY';
    const key = isAuxiliary
      ? `${event.eventType}|${event.sourceReference ?? ''}|${path.pathId}`
      : `${event.eventType}|${event.protectionFunction ?? ''}|${event.breakerStatus ?? ''}`;

    const now = Date.now();
    // Prune expired keys so the map cannot grow without bound on a long-running gateway.
    for (const [k, v] of managed.lastEventKeys) {
      if (now - v.at > this.dedupWindowMs * 4) managed.lastEventKeys.delete(k);
    }

    const previous = managed.lastEventKeys.get(key);
    if (previous && now - previous.at < this.dedupWindowMs) {
      // Same event already seen on another path within the window. Keep whichever copy has the
      // more trustworthy clock, and note the corroborating source.
      const prevRank = TIME_SYNC_TRUST_RANK[previous.event.timeSyncQuality ?? 'UNKNOWN'];
      const thisRank = TIME_SYNC_TRUST_RANK[event.timeSyncQuality ?? 'UNKNOWN'];
      if (thisRank > prevRank) {
        const merged: UnifiedEvent = {
          ...event,
          message: `${event.message} (also reported via ${PROTOCOL_CATALOGUE[previous.event.sourceProtocol as keyof typeof PROTOCOL_CATALOGUE]?.displayName ?? previous.event.sourceProtocol})`,
        };
        managed.lastEventKeys.set(key, { at: previous.at, event: merged });
        this.emit('event', merged, { superseded: previous.event.eventId });
      }
      return; // the lower-quality duplicate is dropped
    }

    managed.lastEventKeys.set(key, { at: now, event });
    this.emit('event', event);

    // A comms event on the active path triggers failover consideration immediately rather than
    // waiting for the next supervision tick.
    if (event.eventType === 'COMM_LOST' && path.pathId === managed.activePathId) {
      void this.considerFailover(profile);
    }
  }

  /** Promote the best currently-connected non-auxiliary path. */
  private async considerFailover(profile: RelayCommProfile) {
    const managed = this.relays.get(profile.relayId);
    if (!managed) return;

    const candidates = [...profile.paths]
      .filter((p) => p.enabled && p.role !== 'AUXILIARY')
      .sort((a, b) => this.rolePriority(a) - this.rolePriority(b));

    for (const path of candidates) {
      const driver = this.options.registry.get(path.protocol);
      const d = driver.diagnostics(path);
      const stale =
        d.lastDataAt !== undefined &&
        Date.now() - new Date(d.lastDataAt).getTime() > path.supervisionTimeoutSec * 1000;

      if (d.state === 'CONNECTED' && !stale) {
        if (managed.activePathId !== path.pathId) {
          const previous = managed.activePathId;
          managed.activePathId = path.pathId;
          this.emit('pathChanged', {
            relayId: profile.relayId,
            relayCode: profile.relayCode,
            from: previous,
            to: path.pathId,
            protocol: path.protocol,
            reason: previous ? 'primary path lost' : 'initial selection',
          });
        }
        return;
      }
    }

    // Nothing usable left.
    if (managed.activePathId) {
      const lost = managed.activePathId;
      managed.activePathId = undefined;
      this.emit('pathChanged', {
        relayId: profile.relayId,
        relayCode: profile.relayCode,
        from: lost,
        to: undefined,
        reason: 'all paths unavailable',
      });
    }
  }

  /** Periodic liveness check across every managed relay. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const allDiagnostics: ConnectionDiagnostics[] = [];
      for (const managed of this.relays.values()) {
        for (const path of managed.profile.paths) {
          if (!path.enabled) continue;
          const driver = this.options.registry.get(path.protocol);
          const d = driver.diagnostics(path);
          allDiagnostics.push(d);

          const stale =
            d.lastDataAt !== undefined &&
            Date.now() - new Date(d.lastDataAt).getTime() > path.supervisionTimeoutSec * 1000;
          if (stale && d.state === 'CONNECTED') {
            // The socket may still be open while the peer has gone silent — that is precisely what
            // supervision timeouts exist to catch.
            this.emit('event', this.buildCommLost(managed.profile, path, d));
            void this.considerFailover(managed.profile);
          }
        }
        if (!managed.activePathId) void this.considerFailover(managed.profile);
      }
      this.emit('diagnostics', allDiagnostics);
    }, this.supervisionIntervalMs);
  }

  private buildCommLost(profile: RelayCommProfile, path: CommPath, d: ConnectionDiagnostics): UnifiedEvent {
    return {
      eventId: `${profile.relayId}-commlost-${Date.now()}`,
      timestamp: new Date().toISOString(),
      projectId: '',
      provinceId: '',
      cityId: '',
      relayId: profile.relayId,
      eventType: 'COMM_LOST',
      severity: 'HIGH',
      sourceProtocol: path.protocol,
      message: `No data from ${profile.relayCode} on ${PROTOCOL_CATALOGUE[path.protocol].displayName} for more than ${path.supervisionTimeoutSec}s.`,
      synthetic: false,
      timeSyncQuality: 'GATEWAY_STAMPED',
      sourcePathId: path.pathId,
      sourceReference: `supervision-timeout; last data ${d.lastDataAt ?? 'never'}`,
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async removeRelay(relayId: string) {
    const managed = this.relays.get(relayId);
    if (!managed) return;
    managed.unsubscribes.forEach((fn) => fn());
    for (const path of managed.profile.paths) {
      if (!path.enabled) continue;
      await this.options.registry.get(path.protocol).disconnect(path);
    }
    this.relays.delete(relayId);
  }

  /** Read status via the currently active path, falling back to any connected path. */
  async readStatus(relayId: string): Promise<RelayStatusSnapshotV2 | null> {
    const managed = this.relays.get(relayId);
    if (!managed) return null;

    const ordered = [...managed.profile.paths].sort((a, b) => {
      if (a.pathId === managed.activePathId) return -1;
      if (b.pathId === managed.activePathId) return 1;
      return this.rolePriority(a) - this.rolePriority(b);
    });

    for (const path of ordered) {
      if (!path.enabled || path.role === 'AUXILIARY') continue;
      const driver = this.options.registry.get(path.protocol);
      if (driver.diagnostics(path).state !== 'CONNECTED') continue;
      try {
        return await driver.readStatus(path, managed.profile);
      } catch {
        continue; // try the next path rather than failing the whole read
      }
    }
    return null;
  }

  /** Full diagnostics for the gateway health endpoint and the admin UI. */
  allDiagnostics(): Array<ConnectionDiagnostics & { relayId: string; relayCode: string; role: CommPath['role']; isActive: boolean }> {
    const out: Array<ConnectionDiagnostics & { relayId: string; relayCode: string; role: CommPath['role']; isActive: boolean }> = [];
    for (const managed of this.relays.values()) {
      for (const path of managed.profile.paths) {
        const driver = this.options.registry.get(path.protocol);
        out.push({
          ...driver.diagnostics(path),
          relayId: managed.profile.relayId,
          relayCode: managed.profile.relayCode,
          role: path.role,
          isActive: managed.activePathId === path.pathId,
        });
      }
    }
    return out;
  }

  /** Best time-sync quality currently available for a relay, across all its paths. */
  bestTimeSyncQuality(relayId: string): TimeSyncQuality {
    const managed = this.relays.get(relayId);
    if (!managed) return 'UNKNOWN';
    let best: TimeSyncQuality = 'UNKNOWN';
    for (const path of managed.profile.paths) {
      const q = this.options.registry.get(path.protocol).diagnostics(path).timeSyncQuality;
      if (TIME_SYNC_TRUST_RANK[q] > TIME_SYNC_TRUST_RANK[best]) best = q;
    }
    return best;
  }
}
