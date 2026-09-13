import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';

export const executiveRouter = createRouter();

// Executive dashboard (spec §24) — management-level KPIs only, no relay protocol detail.
executiveRouter.get('/summary', async (_req, res) => {
  const [projectKpis, relayKpis, faultKpis] = await Promise.all([
    pool.query('SELECT * FROM v_project_kpis'),
    pool.query('SELECT * FROM v_relay_kpis'),
    pool.query('SELECT * FROM v_fault_kpis'),
  ]);
  const { rows: openWorkOrders } = await pool.query(`SELECT COUNT(*) AS count FROM work_orders WHERE status <> 'CLOSED'`);
  const { rows: delayed } = await pool.query(`
    SELECT COUNT(*) AS count FROM projects
    WHERE status NOT IN ('RUNNING','COMPLETED','BLOCKED') AND expected_completion < now()
  `);
  const { rows: atRisk } = await pool.query(`
    SELECT COUNT(*) AS count FROM projects WHERE health_score IS NOT NULL AND health_score < 55
  `);
  const { rows: monthlyTrend } = await pool.query(`
    SELECT date_trunc('month', "timestamp")::date AS month, COUNT(*) AS count
    FROM faults WHERE "timestamp" > now() - INTERVAL '6 months' GROUP BY 1 ORDER BY 1
  `);
  const { rows: forecast } = await pool.query(`
    SELECT code, name, expected_completion, overall_progress FROM projects
    WHERE status NOT IN ('RUNNING','COMPLETED','BLOCKED') ORDER BY expected_completion ASC LIMIT 8
  `);

  const p = projectKpis.rows[0];
  const r = relayKpis.rows[0];
  const f = faultKpis.rows[0];

  res.json({
    totalProjects: Number(p.total_projects),
    projectsRunning: Number(p.running_projects),
    projectsDelayed: Number(delayed[0].count),
    projectsAtRisk: Number(atRisk[0].count),
    criticalFaults: Number(f.critical_alarms),
    openWorkOrders: Number(openWorkOrders[0].count),
    relayFleetHealthPercent: r.total_relays > 0 ? Math.round((Number(r.online_relays) / Number(r.total_relays)) * 100) : null,
    citiesCovered: Number(p.cities_with_projects),
    commissioningProjects: Number(p.commissioning_projects),
    monthlyFaultTrend: monthlyTrend,
    completionForecast: forecast,
    isDemoData: true,
  });
});
