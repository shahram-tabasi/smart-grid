import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';
import { processEnvelopes } from '../events/consumer';

export const ingestRouter = createRouter();

/**
 * HTTP ingest endpoint for edge gateways running EVENT_BUS=direct.
 *
 * Authentication is a per-gateway bearer token, deliberately separate from the user JWT scheme:
 * a gateway is not a user, has no role, and must not be able to call anything else in the API.
 * The token grants exactly one capability — submitting events for its own registered gateway id.
 *
 * Note the direction of travel: the gateway connects OUT to this endpoint. The backend never
 * connects in to a gateway, which is what keeps the protection network unreachable from the
 * outside even if this service is compromised.
 */

async function authenticateGateway(gatewayId: string | undefined, token: string | undefined) {
  if (!gatewayId || !token) return null;
  const expected = process.env.INGEST_TOKEN;
  // Single shared token is acceptable for a small deployment; per-gateway tokens live in
  // edge_gateways for larger fleets (see docs/OPERATIONS_MANUAL.md).
  if (!expected || token !== expected) return null;

  const { rows } = await pool.query(
    `SELECT id, gateway_id, enabled FROM edge_gateways WHERE gateway_id = $1`,
    [gatewayId]
  );
  if (!rows[0]) {
    // Auto-register on first contact so commissioning a gateway does not require a manual DB step,
    // but leave it disabled until an administrator enables it — an unknown gateway should not be
    // able to inject events into a protection monitoring system unreviewed.
    await pool.query(
      `INSERT INTO edge_gateways (gateway_id, display_name, enabled) VALUES ($1, $2, FALSE)
       ON CONFLICT (gateway_id) DO NOTHING`,
      [gatewayId, gatewayId]
    );
    return { pending: true, enabled: false };
  }
  return { pending: false, enabled: rows[0].enabled };
}

ingestRouter.post('/events', async (req, res) => {
  const gatewayId = req.header('X-Gateway-Id') ?? undefined;
  const auth = (req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '') || undefined;

  const gateway = await authenticateGateway(gatewayId, auth);
  if (!gateway) return res.status(401).json({ error: 'Gateway authentication failed' });
  if (!gateway.enabled) {
    return res.status(403).json({
      error: gateway.pending
        ? 'This gateway is registered but not yet enabled. An administrator must enable it before its events are accepted.'
        : 'This gateway is disabled.',
    });
  }

  const envelopes = req.body?.events;
  if (!Array.isArray(envelopes)) {
    return res.status(400).json({ error: 'Body must be { events: EventEnvelope[] }' });
  }
  if (envelopes.length > 1000) {
    return res.status(413).json({ error: 'Batch too large; send at most 1000 events per request' });
  }

  const result = await processEnvelopes(envelopes);

  await pool.query(
    `UPDATE edge_gateways SET last_seen_at = now(),
       last_sequence = GREATEST(last_sequence, $2)
     WHERE gateway_id = $1`,
    [gatewayId, envelopes[envelopes.length - 1]?.sequence ?? 0]
  );

  res.status(result.rejected.length && !result.accepted ? 422 : 202).json(result);
});

/**
 * Relay/comm-path configuration for a gateway to load at startup (and to refresh periodically),
 * replacing any hardcoded local profile list. Shaped as the edge gateway's RelayCommProfile[]
 * driver contract (packages/shared/src/relay-driver-v2.ts) expects, so the response can be used
 * directly in place of the gateway's demoProfiles().
 *
 * point_map_profile_id is stored per comm path in the schema, but RelayCommProfile carries one per
 * relay; a relay takes the first non-null profile id among its enabled paths.
 */
ingestRouter.get('/config', async (req, res) => {
  const gatewayId = req.header('X-Gateway-Id') ?? undefined;
  const auth = (req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '') || undefined;
  const gateway = await authenticateGateway(gatewayId, auth);
  if (!gateway) return res.status(401).json({ error: 'Gateway authentication failed' });
  if (!gateway.enabled) {
    return res.status(403).json({
      error: gateway.pending
        ? 'This gateway is registered but not yet enabled. An administrator must enable it before it can load relay configuration.'
        : 'This gateway is disabled.',
    });
  }

  const { rows } = await pool.query(
    `SELECT r.id AS relay_id, r.relay_code, r.manufacturer, r.model,
            cp.path_id, cp.protocol, cp.role, cp.host, cp.port,
            cp.serial_device, cp.serial_baud_rate, cp.serial_link_address,
            cp.credentials_ref, cp.addressing, cp.poll_interval_ms,
            cp.supervision_timeout_s, cp.point_map_profile_id
     FROM relay_comm_paths cp
     JOIN relays r ON r.id = cp.relay_id
     WHERE cp.enabled = TRUE
     ORDER BY r.relay_code, CASE cp.role WHEN 'PRIMARY' THEN 0 WHEN 'BACKUP' THEN 1 ELSE 2 END, cp.path_id`
  );

  interface ConfigProfile {
    relayId: string;
    relayCode: string;
    manufacturer: string;
    model: string;
    pointMapProfileId?: string;
    paths: unknown[];
  }
  const byRelay = new Map<string, ConfigProfile>();
  for (const r of rows) {
    let profile = byRelay.get(r.relay_id);
    if (!profile) {
      profile = {
        relayId: r.relay_id,
        relayCode: r.relay_code,
        manufacturer: r.manufacturer,
        model: r.model,
        paths: [],
      };
      byRelay.set(r.relay_id, profile);
    }
    if (!profile.pointMapProfileId && r.point_map_profile_id) profile.pointMapProfileId = r.point_map_profile_id;
    profile.paths.push({
      pathId: r.path_id,
      protocol: r.protocol,
      role: r.role,
      host: r.host ?? undefined,
      port: r.port ?? undefined,
      // dataBits/parity/stopBits aren't columns on relay_comm_paths yet; only devicePath, baudRate
      // and linkAddress are captured today, so serial protocols get reasonable defaults for the rest.
      serial: r.serial_device
        ? {
            devicePath: r.serial_device,
            baudRate: r.serial_baud_rate ?? 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            linkAddress: r.serial_link_address ?? undefined,
          }
        : undefined,
      credentialsRef: r.credentials_ref ?? undefined,
      addressing: r.addressing ?? {},
      pollIntervalMs: r.poll_interval_ms ?? undefined,
      supervisionTimeoutSec: r.supervision_timeout_s,
      enabled: true,
    });
  }

  res.json({ relays: Array.from(byRelay.values()) });
});

/** Gateway heartbeat — lets the fleet view show a gateway as alive even during quiet periods. */
ingestRouter.post('/heartbeat', async (req, res) => {
  const gatewayId = req.header('X-Gateway-Id') ?? undefined;
  const auth = (req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '') || undefined;
  const gateway = await authenticateGateway(gatewayId, auth);
  if (!gateway || !gateway.enabled) return res.status(401).json({ error: 'Gateway authentication failed' });

  await pool.query(
    `UPDATE edge_gateways SET last_seen_at = now(), software_version = COALESCE($2, software_version) WHERE gateway_id = $1`,
    [gatewayId, req.body?.softwareVersion ?? null]
  );

  // Path diagnostics reported by the supervisor.
  const diagnostics = Array.isArray(req.body?.diagnostics) ? req.body.diagnostics : [];
  for (const d of diagnostics) {
    if (!d?.pathId || !d?.relayId) continue;
    await pool.query(
      `INSERT INTO relay_comm_path_status (
         path_row_id, state, state_since, last_data_at, last_error_message,
         consecutive_failures, latency_ms, clock_offset_ms, time_sync_quality,
         frames_received, frames_rejected, is_active_path, updated_at)
       SELECT cp.id, $3, COALESCE($4, now()), $5, $6, $7, $8, $9, $10, $11, $12, $13, now()
       FROM relay_comm_paths cp
       JOIN relays r ON r.id = cp.relay_id
       WHERE cp.path_id = $2 AND (r.id::text = $1 OR r.relay_code = $1)
       ON CONFLICT (path_row_id) DO UPDATE SET
         state = EXCLUDED.state,
         state_since = EXCLUDED.state_since,
         last_data_at = EXCLUDED.last_data_at,
         last_error_message = EXCLUDED.last_error_message,
         consecutive_failures = EXCLUDED.consecutive_failures,
         latency_ms = EXCLUDED.latency_ms,
         clock_offset_ms = EXCLUDED.clock_offset_ms,
         time_sync_quality = EXCLUDED.time_sync_quality,
         frames_received = EXCLUDED.frames_received,
         frames_rejected = EXCLUDED.frames_rejected,
         is_active_path = EXCLUDED.is_active_path,
         updated_at = now()`,
      [
        d.relayId,
        d.pathId,
        d.state ?? 'DISCONNECTED',
        d.since ?? null,
        d.lastDataAt ?? null,
        d.lastErrorMessage ?? null,
        d.consecutiveFailures ?? 0,
        d.latencyMs ?? null,
        d.clockOffsetMs ?? null,
        d.timeSyncQuality ?? 'UNKNOWN',
        d.framesReceived ?? 0,
        d.framesRejected ?? 0,
        d.isActive === true,
      ]
    );
  }

  res.json({ ok: true, diagnosticsRecorded: diagnostics.length });
});
