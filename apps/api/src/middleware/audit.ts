import { pool } from '../db/pool';

/**
 * Every write to audit_log is an INSERT only — the `simorgh_api` database role has no UPDATE/DELETE
 * grant on this table (see db/migrations/013_roles_and_grants.sql), so the log is immutable even if
 * application code has a bug. Call this from any route that performs a security-relevant action.
 */
export async function writeAuditLog(params: {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.userId ?? null,
        params.action,
        params.entityType ?? null,
        params.entityId ?? null,
        JSON.stringify(params.details ?? {}),
        params.ipAddress ?? null,
      ]
    );
  } catch (err) {
    // Audit logging must never crash the request it's observing, but we do want to know about it.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log entry', err);
  }
}
