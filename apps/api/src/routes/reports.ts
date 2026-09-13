import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';

export const reportsRouter = createRouter();

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
}

function send(res: import('express').Response, filename: string, format: string, rows: Record<string, unknown>[]) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(toCsv(rows));
  }
  // PDF/XLSX generation is a documented Phase-1 roadmap item (spec §31) — wire in pdfkit/exceljs (or
  // reuse the platform's document-generation skill) here without changing this endpoint's contract.
  return res.json({ format, rows, note: format !== 'json' ? `${format.toUpperCase()} export not yet wired in Phase 1 — returning JSON. See TODO in apps/api/src/routes/reports.ts.` : undefined });
}

// Daily Operations Report
reportsRouter.get('/daily-operations', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.code AS project_code, c.name_en AS city, f.fault_code, f.fault_type, f.severity,
           f."timestamp", f.resolution_status
    FROM faults f JOIN projects p ON p.id = f.project_id JOIN cities c ON c.id = f.city_id
    WHERE f."timestamp" > now() - INTERVAL '1 day' ORDER BY f."timestamp" DESC
  `);
  send(res, `daily-operations-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});

// Weekly Fault Report
reportsRouter.get('/weekly-fault', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.code AS project_code, f.fault_code, f.fault_type, f.severity, f.trip_status,
           f."timestamp", f.resolution_status, f.assigned_engineer_id
    FROM faults f JOIN projects p ON p.id = f.project_id
    WHERE f."timestamp" > now() - INTERVAL '7 days' ORDER BY f.severity, f."timestamp" DESC
  `);
  send(res, `weekly-fault-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});

// Monthly Project Report
reportsRouter.get('/monthly-project', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT code, name, status, overall_progress, health_score, requires_engineering_intervention,
           requires_field_service, expected_completion, actual_completion
    FROM projects ORDER BY health_score ASC NULLS LAST
  `);
  send(res, `monthly-project-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});

// Relay Health Report
reportsRouter.get('/relay-health', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT relay_code, manufacturer, model, comm_status, health_status, health_score, trip_count,
           alarm_count, last_communication_at
    FROM relays ORDER BY health_score ASC
  `);
  send(res, `relay-health-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});

// Critical Event Report
reportsRouter.get('/critical-event', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.code AS project_code, f.fault_code, f.fault_type, f."timestamp", f.resolution_status
    FROM faults f JOIN projects p ON p.id = f.project_id
    WHERE f.severity = 'CRITICAL' ORDER BY f."timestamp" DESC LIMIT 200
  `);
  send(res, `critical-event-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});

// Project Delay Report
reportsRouter.get('/project-delay', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT code, name, status, expected_completion, overall_progress
    FROM projects
    WHERE status NOT IN ('RUNNING','COMPLETED','BLOCKED') AND expected_completion < now() + INTERVAL '30 days'
    ORDER BY expected_completion ASC
  `);
  send(res, `project-delay-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});

// AI Risk Report
reportsRouter.get('/ai-risk', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.code AS project_code, a.summary, a.probable_cause, a.confidence_score, a.priority, a.created_at
    FROM ai_analyses a JOIN faults f ON f.id = a.fault_id JOIN projects p ON p.id = f.project_id
    ORDER BY a.created_at DESC LIMIT 200
  `);
  send(res, `ai-risk-${new Date().toISOString().slice(0, 10)}`, (req.query.format as string) || 'json', rows);
});
