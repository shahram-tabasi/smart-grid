import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';
import { requireAuth, requireRole, requirePrecisionLocationAccess } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';

export const adminRouter = createRouter();

// Audit log is admin-only reading of an append-only table (see db/migrations/010 + 013).
adminRouter.get('/audit-log', requireAuth, requireRole('ADMIN', 'EXECUTIVE'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a."time", u.full_name AS user_name, a.action, a.entity_type, a.entity_id, a.details
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a."time" DESC LIMIT 200`
  );
  res.json({ entries: rows });
});

adminRouter.get('/users', requireAuth, requireRole('ADMIN', 'PROJECT_MANAGER', 'TECHNICAL_MANAGER'), async (_req, res) => {
  const { rows } = await pool.query('SELECT id, full_name, email, role FROM users WHERE is_active = true ORDER BY role, full_name');
  res.json({ users: rows });
});

// Demonstrates the narrow, explicitly-authorized, audit-logged exception described in
// docs/ARCHITECTURE.md §9. Disabled for every role by default (users.can_read_precise_location = false).
adminRouter.get('/substations/:id/precise-location', requireAuth, requirePrecisionLocationAccess, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT substation_id, address, latitude, longitude, access_notes FROM site_location_restricted WHERE substation_id = $1',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No restricted location record for this substation' });
  await writeAuditLog({
    userId: req.user!.id, action: 'PRECISE_LOCATION_READ', entityType: 'SUBSTATION', entityId: req.params.id, ipAddress: req.ip,
  });
  res.json(rows[0]);
});
