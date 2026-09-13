import { createRouter } from '../middleware/safeRouter';
import { requireAuth, requireRole } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';
import { pool } from '../db/pool';

export const workOrdersRouter = createRouter();

const WORKFLOW: string[] = ['OPEN', 'ANALYSIS', 'ASSIGNED', 'FIELD_INSPECTION', 'REPAIR', 'TEST', 'VERIFIED', 'CLOSED'];

workOrdersRouter.get('/', async (req, res) => {
  const { status, priority, projectId } = req.query as Record<string, string | undefined>;
  const conditions: string[] = [];
  const params: any[] = [];
  if (status) { params.push(status); conditions.push(`wo.status = $${params.length}`); }
  if (priority) { params.push(priority); conditions.push(`wo.priority = $${params.length}`); }
  if (projectId) { params.push(projectId); conditions.push(`wo.project_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT wo.*, p.code AS project_code, p.name AS project_name, c.name_en AS city_name_en, c.name_fa AS city_name_fa,
            u.full_name AS assigned_engineer_name, f.fault_code
     FROM work_orders wo
     JOIN projects p ON p.id = wo.project_id
     JOIN cities c ON c.id = wo.city_id
     LEFT JOIN users u ON u.id = wo.assigned_engineer_id
     LEFT JOIN faults f ON f.id = wo.fault_id
     ${where}
     ORDER BY CASE wo.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, wo.created_at DESC`,
    params
  );
  res.json({ workOrders: rows, total: rows.length });
});

workOrdersRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT wo.*, p.code AS project_code, p.name AS project_name, u.full_name AS assigned_engineer_name, f.fault_code
     FROM work_orders wo
     JOIN projects p ON p.id = wo.project_id
     LEFT JOIN users u ON u.id = wo.assigned_engineer_id
     LEFT JOIN faults f ON f.id = wo.fault_id
     WHERE wo.id::text = $1 OR wo.work_order_code = $1`,
    [req.params.id]
  );
  const wo = rows[0];
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const { rows: history } = await pool.query(
    `SELECT h.from_status, h.to_status, h.changed_at, h.note, u.full_name AS changed_by_name
     FROM work_order_status_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.work_order_id = $1 ORDER BY h.changed_at`,
    [wo.id]
  );
  res.json({ ...wo, history });
});

workOrdersRouter.post('/', requireAuth, requireRole('ADMIN', 'TECHNICAL_MANAGER', 'PROJECT_MANAGER', 'PROTECTION_ENGINEER'), async (req, res) => {
  const { faultId, projectId, cityId, equipmentDescription, problem, priority, assignedEngineerId, dueDate } = req.body ?? {};
  if (!projectId || !cityId || !equipmentDescription || !problem) {
    return res.status(400).json({ error: 'projectId, cityId, equipmentDescription and problem are required' });
  }
  const code = `WO-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;
  const { rows } = await pool.query(
    `INSERT INTO work_orders (work_order_code, fault_id, project_id, city_id, equipment_description, problem, priority, assigned_engineer_id, due_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'MEDIUM'),$8,$9,'OPEN') RETURNING id, work_order_code`,
    [code, faultId ?? null, projectId, cityId, equipmentDescription, problem, priority ?? null, assignedEngineerId ?? null, dueDate ?? null]
  );
  await pool.query(`INSERT INTO work_order_status_history (work_order_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'OPEN', $2)`, [rows[0].id, req.user!.id]);
  await writeAuditLog({ userId: req.user!.id, action: 'WORK_ORDER_CREATE', entityType: 'WORK_ORDER', entityId: rows[0].id, ipAddress: req.ip });
  res.status(201).json(rows[0]);
});

workOrdersRouter.post('/:id/transition', requireAuth, requireRole('ADMIN', 'TECHNICAL_MANAGER', 'PROJECT_MANAGER', 'PROTECTION_ENGINEER', 'FIELD_SERVICE_ENGINEER'), async (req, res) => {
  const { toStatus, note } = req.body ?? {};
  if (!WORKFLOW.includes(toStatus)) {
    return res.status(400).json({ error: `toStatus must be one of: ${WORKFLOW.join(' -> ')}` });
  }
  const { rows: current } = await pool.query('SELECT status FROM work_orders WHERE id = $1', [req.params.id]);
  if (!current[0]) return res.status(404).json({ error: 'Work order not found' });

  await pool.query(
    `UPDATE work_orders SET status = $2, updated_at = now(), closed_at = ${toStatus === 'CLOSED' ? 'now()' : 'closed_at'} WHERE id = $1`,
    [req.params.id, toStatus]
  );
  await pool.query(
    `INSERT INTO work_order_status_history (work_order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [req.params.id, current[0].status, toStatus, req.user!.id, note ?? null]
  );
  await writeAuditLog({ userId: req.user!.id, action: 'WORK_ORDER_TRANSITION', entityType: 'WORK_ORDER', entityId: req.params.id, details: { from: current[0].status, to: toStatus }, ipAddress: req.ip });
  res.json({ ok: true });
});
