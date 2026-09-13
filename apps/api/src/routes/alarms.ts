import { createRouter } from '../middleware/safeRouter';
import { requireAuth, requireRole } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';
import { pool } from '../db/pool';

export const alarmsRouter = createRouter();

alarmsRouter.get('/', async (req, res) => {
  const { status, priority, projectId } = req.query as Record<string, string | undefined>;
  const conditions: string[] = [];
  const params: any[] = [];
  if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
  if (priority) { params.push(priority); conditions.push(`a.priority = $${params.length}`); }
  if (projectId) { params.push(projectId); conditions.push(`a.project_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT a.*, p.code AS project_code, p.name AS project_name, r.relay_code,
            u.full_name AS assigned_to_name, g.root_cause AS correlation_root_cause,
            (SELECT COUNT(*) FROM alarms a2 WHERE a2.correlation_group_id = a.correlation_group_id) AS correlated_count
     FROM alarms a
     LEFT JOIN projects p ON p.id = a.project_id
     LEFT JOIN relays r ON r.id = a.relay_id
     LEFT JOIN users u ON u.id = a.assigned_to
     LEFT JOIN alarm_correlation_groups g ON g.id = a.correlation_group_id
     ${where}
     ORDER BY
       CASE a.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,
       a.created_at DESC
     LIMIT 300`,
    params
  );
  res.json({ alarms: rows, total: rows.length });
});

alarmsRouter.get('/:id/comments', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.comment, c.created_at, u.full_name AS author_name
     FROM alarm_comments c JOIN users u ON u.id = c.user_id
     WHERE c.alarm_id = $1 ORDER BY c.created_at`,
    [req.params.id]
  );
  res.json({ comments: rows });
});

alarmsRouter.post('/:id/acknowledge', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE alarms SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'OPEN' RETURNING id`,
    [req.params.id, req.user!.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Alarm not found or not in OPEN status' });
  await writeAuditLog({ userId: req.user!.id, action: 'ALARM_ACK', entityType: 'ALARM', entityId: rows[0].id, ipAddress: req.ip });
  res.json({ ok: true });
});

alarmsRouter.post('/:id/comments', requireAuth, async (req, res) => {
  const { comment } = req.body ?? {};
  if (!comment) return res.status(400).json({ error: 'comment is required' });
  await pool.query('INSERT INTO alarm_comments (alarm_id, user_id, comment) VALUES ($1, $2, $3)', [req.params.id, req.user!.id, comment]);
  res.status(201).json({ ok: true });
});

// Suppression requires elevated authorization (spec §15 "Alarm suppression with authorization").
alarmsRouter.post('/:id/suppress', requireAuth, requireRole('ADMIN', 'TECHNICAL_MANAGER', 'PROTECTION_ENGINEER'), async (req, res) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: 'reason is required to suppress an alarm' });
  const { rows } = await pool.query(
    `UPDATE alarms SET status = 'SUPPRESSED', suppressed_by = $2, suppression_reason = $3, updated_at = now()
     WHERE id = $1 RETURNING id`,
    [req.params.id, req.user!.id, reason]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Alarm not found' });
  await writeAuditLog({ userId: req.user!.id, action: 'ALARM_SUPPRESS', entityType: 'ALARM', entityId: rows[0].id, details: { reason }, ipAddress: req.ip });
  res.json({ ok: true });
});
