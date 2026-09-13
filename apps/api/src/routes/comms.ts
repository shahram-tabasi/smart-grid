import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/auth';
import { PROTOCOL_CATALOGUE, TIME_SYNC_TRUST_RANK } from '@simorgh/shared';

export const commsRouter = createRouter();

/**
 * Communications & protocol health.
 *
 * Note what is NOT exposed here: `host`, `port` and `serial_device` are equipment network
 * addresses on the OT network. They are returned only to ADMIN and PROTECTION_ENGINEER roles,
 * because handing the addressable location of every protection relay to a read-only viewer is the
 * network-layer equivalent of exposing the site coordinates.
 */

/** The static protocol catalogue — what the platform can speak, and with what caveats. */
commsRouter.get('/protocols', async (_req, res) => {
  const protocols = Object.values(PROTOCOL_CATALOGUE).map((d) => ({
    protocol: d.protocol,
    tier: d.tier,
    displayName: d.displayName,
    family: d.family,
    transport: d.transport,
    deliveryMode: d.deliveryMode,
    defaultPort: d.defaultPort ?? null,
    implementation: d.implementation,
    commonVendors: d.commonVendors,
    notes: d.notes,
    capabilities: d.capabilities,
  }));
  res.json({ protocols, total: protocols.length });
});

/** How the catalogue is actually being used across the estate. */
commsRouter.get('/protocol-usage', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM v_protocol_usage ORDER BY relay_count DESC');
  const enriched = rows.map((r) => ({
    ...r,
    displayName: PROTOCOL_CATALOGUE[r.protocol as keyof typeof PROTOCOL_CATALOGUE]?.displayName ?? r.protocol,
    family: PROTOCOL_CATALOGUE[r.protocol as keyof typeof PROTOCOL_CATALOGUE]?.family ?? 'UNKNOWN',
  }));
  res.json({ usage: enriched });
});

/** Per-relay communication health, including whether redundancy actually exists. */
commsRouter.get('/relay-health', async (req, res) => {
  const { onlyProblems } = req.query as Record<string, string | undefined>;
  const { rows } = await pool.query(
    `SELECT * FROM v_relay_comm_health
     ${onlyProblems === 'true' ? 'WHERE NOT has_active_path OR NOT is_redundant OR configured_paths = 0' : ''}
     ORDER BY has_active_path ASC, is_redundant ASC, relay_code
     LIMIT 500`
  );

  // Flag relays whose only source is a protocol that cannot carry a trustworthy event record.
  const flagged = rows.map((r) => {
    const warnings: string[] = [];
    if (Number(r.configured_paths) === 0) warnings.push('No communication path is configured for this relay.');
    else if (!r.has_active_path) warnings.push('No path is currently carrying data.');
    if (Number(r.configured_paths) > 0 && !r.is_redundant) {
      warnings.push('Single path — a link failure blinds monitoring for this relay entirely.');
    }
    if (['GATEWAY_STAMPED', 'UNKNOWN'].includes(String(r.worst_time_sync_quality))) {
      warnings.push('Timestamps from this relay are gateway-stamped; its events cannot be placed on a millisecond timeline with confidence.');
    }
    return { ...r, warnings };
  });

  res.json({ relays: flagged, total: flagged.length });
});

/** All configured paths for one relay. Addresses redacted unless the caller is authorised. */
commsRouter.get('/relay/:relayId/paths', requireAuth, async (req, res) => {
  const privileged = ['ADMIN', 'PROTECTION_ENGINEER'].includes(req.user!.role);

  const { rows } = await pool.query(
    `SELECT cp.id, cp.path_id, cp.protocol, cp.role, cp.enabled, cp.poll_interval_ms,
            cp.supervision_timeout_s, cp.point_map_profile_id, cp.addressing,
            cp.host, cp.port, cp.serial_device, cp.serial_baud_rate, cp.serial_link_address,
            cps.state, cps.state_since, cps.last_data_at, cps.last_error_message,
            cps.consecutive_failures, cps.latency_ms, cps.clock_offset_ms,
            cps.time_sync_quality, cps.frames_received, cps.frames_rejected, cps.is_active_path
     FROM relay_comm_paths cp
     LEFT JOIN relay_comm_path_status cps ON cps.path_row_id = cp.id
     JOIN relays r ON r.id = cp.relay_id
     WHERE r.id::text = $1 OR r.relay_code = $1
     ORDER BY CASE cp.role WHEN 'PRIMARY' THEN 0 WHEN 'BACKUP' THEN 1 ELSE 2 END, cp.path_id`,
    [req.params.relayId]
  );

  const paths = rows.map((r) => {
    const descriptor = PROTOCOL_CATALOGUE[r.protocol as keyof typeof PROTOCOL_CATALOGUE];
    const base = {
      ...r,
      displayName: descriptor?.displayName ?? r.protocol,
      family: descriptor?.family ?? 'UNKNOWN',
      capabilities: descriptor?.capabilities ?? null,
      implementation: descriptor?.implementation ?? 'UNKNOWN',
      timeSyncTrustRank: TIME_SYNC_TRUST_RANK[(r.time_sync_quality ?? 'UNKNOWN') as keyof typeof TIME_SYNC_TRUST_RANK],
    };
    if (privileged) return base;
    // Redact OT network addressing for non-privileged roles.
    return {
      ...base,
      host: null,
      port: null,
      serial_device: null,
      serial_baud_rate: null,
      serial_link_address: null,
      addressing: {},
      addressRedacted: true,
    };
  });

  res.json({ paths, addressesVisible: privileged });
});

/** Gateway fleet. */
commsRouter.get('/gateways', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT g.gateway_id, g.display_name, g.software_version, g.last_seen_at, g.enabled,
            g.last_sequence, p.code AS project_code, pr.name_en AS province_name_en,
            c.name_en AS city_name_en,
            (g.last_seen_at IS NULL OR g.last_seen_at < now() - INTERVAL '5 minutes') AS is_stale
     FROM edge_gateways g
     LEFT JOIN projects p ON p.id = g.project_id
     LEFT JOIN provinces pr ON pr.id = g.province_id
     LEFT JOIN cities c ON c.id = g.city_id
     ORDER BY g.enabled DESC, g.last_seen_at DESC NULLS LAST`
  );
  res.json({ gateways: rows, total: rows.length });
});

/** Enable a gateway that auto-registered on first contact. Admin only, and audited. */
commsRouter.post('/gateways/:gatewayId/enable', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE edge_gateways SET enabled = TRUE WHERE gateway_id = $1 RETURNING gateway_id`,
    [req.params.gatewayId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Gateway not found' });
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1, 'GATEWAY_ENABLE', 'GATEWAY', $2, '{}'::jsonb, $3)`,
    [req.user!.id, req.params.gatewayId, req.ip]
  );
  res.json({ ok: true });
});

/** Ingest failures — events that could not be stored, and therefore need a human. */
commsRouter.get('/dead-letter', requireAuth, requireRole('ADMIN', 'PROTECTION_ENGINEER'), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, received_at, gateway_id, reason, raw_payload, reviewed
     FROM event_dead_letter WHERE NOT reviewed ORDER BY received_at DESC LIMIT 200`
  );
  res.json({ entries: rows, total: rows.length });
});

/** Time-sync health across the estate — the honesty check on the fault timeline. */
commsRouter.get('/time-sync', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT cps.time_sync_quality, COUNT(*) AS path_count,
            AVG(ABS(cps.clock_offset_ms)) AS avg_abs_offset_ms,
            MAX(ABS(cps.clock_offset_ms)) AS worst_abs_offset_ms
     FROM relay_comm_path_status cps
     GROUP BY cps.time_sync_quality
     ORDER BY 1`
  );
  const { rows: recentEvents } = await pool.query(
    `SELECT time_sync_quality, COUNT(*) AS event_count
     FROM events WHERE "time" > now() - INTERVAL '24 hours'
     GROUP BY time_sync_quality ORDER BY event_count DESC`
  );
  res.json({ paths: rows, eventsLast24h: recentEvents });
});

/** Point-map profiles — the data that keeps the platform vendor-neutral. */
commsRouter.get('/point-maps', requireAuth, async (_req, res) => {
  // protocol_count is how many protocols this profile carries a map for. jsonb_object_keys is a
  // set-returning function, so it is counted in a lateral subquery rather than inline.
  const { rows } = await pool.query(
    `SELECT p.profile_id, p.display_name, p.manufacturer, p.models, p.is_built_in, p.updated_at,
            k.protocol_count
     FROM point_map_profiles p
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS protocol_count FROM jsonb_object_keys(p.points)
     ) k
     ORDER BY p.manufacturer, p.display_name`
  );
  res.json({ profiles: rows });
});
