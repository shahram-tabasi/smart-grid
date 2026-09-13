import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';

export const relaysRouter = createRouter();

relaysRouter.get('/', async (req, res) => {
  const { commStatus, healthStatus, manufacturer, projectId, search } = req.query as Record<string, string | undefined>;
  const conditions: string[] = [];
  const params: any[] = [];
  if (commStatus) { params.push(commStatus); conditions.push(`r.comm_status = $${params.length}`); }
  if (healthStatus) { params.push(healthStatus); conditions.push(`r.health_status = $${params.length}`); }
  if (manufacturer) { params.push(manufacturer); conditions.push(`r.manufacturer = $${params.length}`); }
  if (projectId) { params.push(projectId); conditions.push(`p.id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(r.relay_code ILIKE $${params.length} OR r.model ILIKE $${params.length})`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT r.id, r.relay_code, r.manufacturer, r.model, r.protocol, r.voltage_level,
            r.comm_status, r.protection_status, r.breaker_status, r.active_setting_group,
            r.last_communication_at, r.last_event_at, r.last_trip_at, r.alarm_count, r.trip_count,
            r.health_score, r.health_status,
            p.id AS project_id, p.code AS project_code, p.name AS project_name,
            c.id AS city_id, c.name_en AS city_name_en, c.name_fa AS city_name_fa,
            pnl.name AS panel_name, pnl.panel_type
     FROM relays r
     JOIN panels pnl ON pnl.id = r.panel_id
     JOIN switchgear sg ON sg.id = pnl.switchgear_id
     JOIN substations s ON s.id = sg.substation_id
     JOIN projects p ON p.id = s.project_id
     JOIN cities c ON c.id = p.city_id
     ${where}
     ORDER BY r.health_score ASC, r.relay_code`,
    params
  );
  res.json({ relays: rows, total: rows.length });
});

relaysRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM v_equipment_hierarchy WHERE relay_id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Relay not found' });

  const { rows: relayRow } = await pool.query('SELECT * FROM relays WHERE id = $1', [req.params.id]);
  const { rows: functions } = await pool.query('SELECT * FROM protection_functions WHERE relay_id = $1', [req.params.id]);
  const { rows: recentEvents } = await pool.query(
    `SELECT id, "time", event_type, protection_function, severity, breaker_status, message, measurements
     FROM events WHERE relay_id = $1 ORDER BY "time" DESC LIMIT 50`,
    [req.params.id]
  );
  const { rows: faults } = await pool.query(
    `SELECT id, fault_code, "timestamp", fault_type, severity, trip_status, resolution_status
     FROM faults WHERE relay_id = $1 ORDER BY "timestamp" DESC LIMIT 20`,
    [req.params.id]
  );

  res.json({ hierarchy: rows[0], relay: relayRow[0], protectionFunctions: functions, recentEvents, faults });
});
