import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';

export const dashboardRouter = createRouter();

// Backs the Overview dashboard KPI tiles (spec §1). Pulls from the pre-aggregated views in
// db/migrations/012_dashboard_views.sql so this stays a handful of cheap queries.
dashboardRouter.get('/kpis', async (_req, res) => {
  const [projectKpis, relayKpis, faultKpis, alarmKpis] = await Promise.all([
    pool.query('SELECT * FROM v_project_kpis'),
    pool.query('SELECT * FROM v_relay_kpis'),
    pool.query('SELECT * FROM v_fault_kpis'),
    pool.query('SELECT * FROM v_alarm_kpis'),
  ]);
  const p = projectKpis.rows[0];
  const r = relayKpis.rows[0];
  const f = faultKpis.rows[0];
  const a = alarmKpis.rows[0];

  const { rows: commRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM v_project_comm_status WHERE has_comm_problem`
  );

  res.json({
    totalProjects: Number(p.total_projects),
    activeProjects: Number(p.active_projects),
    runningProjects: Number(p.running_projects),
    commissioningProjects: Number(p.commissioning_projects),
    engineeringProjects: Number(p.engineering_projects),
    projectsRequiringEngineering: Number(p.projects_requiring_engineering),
    projectsRequiringFieldService: Number(p.projects_requiring_field_service),
    healthyProjects: Number(p.healthy_projects),
    criticalProjects: Number(p.critical_projects),
    citiesWithProjects: Number(p.cities_with_projects),
    projectsWithCommProblems: Number(commRows[0].count),

    totalRelays: Number(r.total_relays),
    onlineRelays: Number(r.online_relays),
    offlineRelays: Number(r.offline_relays),
    relaysWithAlarms: Number(r.relays_with_alarms),
    relaysWithRecentTrips: Number(r.relays_with_recent_trips),
    criticalRelays: Number(r.critical_relays),

    unresolvedFaults: Number(f.unresolved_faults),
    criticalAlarmsFromFaults: Number(f.critical_alarms),
    faultsLast30d: Number(f.faults_last_30d),

    activeAlarms: Number(a.active_alarms),
    criticalOpenAlarms: Number(a.critical_open_alarms),

    isDemoData: true,
    generatedAt: new Date().toISOString(),
  });
});

// Fault trend for the last 30 days, for the KPI sparkline / trend chart.
dashboardRouter.get('/fault-trend', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT date_trunc('day', "timestamp")::date AS day, COUNT(*) AS count,
      COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical_count
    FROM faults
    WHERE "timestamp" > now() - INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1
  `);
  res.json({ series: rows });
});

// Recent live-feed style events, used as a polling fallback for clients that can't hold a WebSocket open.
dashboardRouter.get('/recent-events', async (req, res) => {
  const since = req.query.since as string | undefined;
  const { rows } = await pool.query(
    `SELECT e.id, e."time", e.event_type, e.severity, e.message, e.breaker_status,
            p.code AS project_code, c.name_en AS city_name_en, c.name_fa AS city_name_fa
     FROM events e
     JOIN projects p ON p.id = e.project_id
     JOIN cities c ON c.id = e.city_id
     WHERE ($1::timestamptz IS NULL OR e."time" > $1::timestamptz)
     ORDER BY e."time" DESC LIMIT 50`,
    [since ?? null]
  );
  res.json({ events: rows });
});
