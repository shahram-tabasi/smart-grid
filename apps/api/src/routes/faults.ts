import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';

export const faultsRouter = createRouter();

faultsRouter.get('/', async (req, res) => {
  const { severity, resolutionStatus, projectId, cityId, protectionFunction } = req.query as Record<string, string | undefined>;
  const conditions: string[] = [];
  const params: any[] = [];
  if (severity) { params.push(severity); conditions.push(`f.severity = $${params.length}`); }
  if (resolutionStatus) { params.push(resolutionStatus); conditions.push(`f.resolution_status = $${params.length}`); }
  if (projectId) { params.push(projectId); conditions.push(`f.project_id = $${params.length}`); }
  if (cityId) { params.push(cityId); conditions.push(`f.city_id = $${params.length}`); }
  if (protectionFunction) { params.push(protectionFunction); conditions.push(`f.protection_function = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT f.id, f.fault_code, f."timestamp", f.fault_type, f.protection_function, f.severity,
            f.breaker_status, f.current_a, f.voltage_kv, f.frequency_hz, f.trip_status,
            f.acknowledgement_status, f.root_cause_status, f.resolution_status,
            p.id AS project_id, p.code AS project_code, p.name AS project_name,
            c.name_en AS city_name_en, c.name_fa AS city_name_fa,
            r.relay_code, pnl.name AS panel_name,
            u.full_name AS assigned_engineer_name
     FROM faults f
     JOIN projects p ON p.id = f.project_id
     JOIN cities c ON c.id = f.city_id
     LEFT JOIN relays r ON r.id = f.relay_id
     LEFT JOIN panels pnl ON pnl.id = f.panel_id
     LEFT JOIN users u ON u.id = f.assigned_engineer_id
     ${where}
     ORDER BY f."timestamp" DESC
     LIMIT 200`,
    params
  );
  res.json({ faults: rows, total: rows.length });
});

faultsRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.*, p.code AS project_code, p.name AS project_name, c.name_en AS city_name_en,
            c.name_fa AS city_name_fa, r.relay_code, r.manufacturer, r.model, pnl.name AS panel_name,
            u.full_name AS assigned_engineer_name, ack.full_name AS acknowledged_by_name
     FROM faults f
     JOIN projects p ON p.id = f.project_id
     JOIN cities c ON c.id = f.city_id
     LEFT JOIN relays r ON r.id = f.relay_id
     LEFT JOIN panels pnl ON pnl.id = f.panel_id
     LEFT JOIN users u ON u.id = f.assigned_engineer_id
     LEFT JOIN users ack ON ack.id = f.acknowledged_by
     WHERE f.id::text = $1 OR f.fault_code = $1`,
    [req.params.id]
  );
  const fault = rows[0];
  if (!fault) return res.status(404).json({ error: 'Fault not found' });

  // Carry each entry's timestamp trust through to the UI. A timeline that mixes GOOSE-grade and
  // gateway-stamped entries must say so rather than implying uniform millisecond precision.
  const { rows: timeline } = await pool.query(
    `SELECT fte.sequence_no, fte."time", fte.description,
            COALESCE(e.time_sync_quality::text, 'UNKNOWN') AS time_sync_quality,
            e.source_protocol
     FROM fault_timeline_entries fte
     LEFT JOIN events e ON e.id = fte.event_id
     WHERE fte.fault_id = $1 ORDER BY fte.sequence_no`,
    [fault.id]
  );
  const { rows: aiAnalyses } = await pool.query(
    `SELECT id, summary, probable_cause, confidence_score, evidence, related_event_ids, recommended_action,
            required_engineer_role, priority, model_version, created_at
     FROM ai_analyses WHERE fault_id = $1 ORDER BY created_at DESC`,
    [fault.id]
  );
  const { rows: comtrade } = await pool.query(
    `SELECT id, recorded_at, sample_rate_hz, duration_ms, pre_fault_ms, post_fault_ms, channels, waveform_preview
     FROM comtrade_records WHERE fault_id = $1`,
    [fault.id]
  );
  const { rows: workOrders } = await pool.query(
    `SELECT id, work_order_code, status, priority, assigned_engineer_id FROM work_orders WHERE fault_id = $1`,
    [fault.id]
  );

  res.json({ ...fault, timeline, aiAnalyses, comtrade, workOrders });
});

// Acknowledge a fault. This is a workflow-state write (ack status), never a control command.
faultsRouter.post('/:id/acknowledge', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE faults SET acknowledgement_status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now(), updated_at = now()
     WHERE id = $1 RETURNING id, fault_code`,
    [req.params.id, req.user!.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Fault not found' });
  await writeAuditLog({ userId: req.user!.id, action: 'FAULT_ACKNOWLEDGE', entityType: 'FAULT', entityId: rows[0].id, ipAddress: req.ip });
  res.json({ ok: true });
});

faultsRouter.post('/:id/assign', requireAuth, requireRole('ADMIN', 'TECHNICAL_MANAGER', 'PROJECT_MANAGER', 'PROTECTION_ENGINEER'), async (req, res) => {
  const { engineerId } = req.body ?? {};
  if (!engineerId) return res.status(400).json({ error: 'engineerId is required' });
  const { rows } = await pool.query(
    `UPDATE faults SET assigned_engineer_id = $2, updated_at = now() WHERE id = $1 RETURNING id, fault_code`,
    [req.params.id, engineerId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Fault not found' });
  await writeAuditLog({ userId: req.user!.id, action: 'FAULT_ASSIGN', entityType: 'FAULT', entityId: rows[0].id, details: { engineerId }, ipAddress: req.ip });
  res.json({ ok: true });
});
