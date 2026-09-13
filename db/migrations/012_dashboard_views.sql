-- 012_dashboard_views.sql
-- Pre-aggregated views backing the Overview / Executive dashboards so the API issues cheap, simple queries.

CREATE VIEW v_project_kpis AS
SELECT
  COUNT(*)                                                        AS total_projects,
  COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED', 'BLOCKED'))  AS active_projects,
  COUNT(*) FILTER (WHERE status = 'RUNNING')                      AS running_projects,
  COUNT(*) FILTER (WHERE status = 'COMMISSIONING')                AS commissioning_projects,
  COUNT(*) FILTER (WHERE status = 'ENGINEERING')                  AS engineering_projects,
  COUNT(*) FILTER (WHERE requires_engineering_intervention)       AS projects_requiring_engineering,
  COUNT(*) FILTER (WHERE requires_field_service)                  AS projects_requiring_field_service,
  COUNT(*) FILTER (WHERE health_score IS NOT NULL AND health_score >= 80) AS healthy_projects,
  COUNT(*) FILTER (WHERE health_score IS NOT NULL AND health_score < 50)  AS critical_projects,
  COUNT(DISTINCT city_id)                                          AS cities_with_projects
FROM projects;

CREATE VIEW v_relay_kpis AS
SELECT
  COUNT(*)                                          AS total_relays,
  COUNT(*) FILTER (WHERE comm_status = 'ONLINE')    AS online_relays,
  COUNT(*) FILTER (WHERE comm_status = 'OFFLINE')   AS offline_relays,
  COUNT(*) FILTER (WHERE alarm_count > 0)           AS relays_with_alarms,
  COUNT(*) FILTER (WHERE last_trip_at > now() - INTERVAL '7 days') AS relays_with_recent_trips,
  COUNT(*) FILTER (WHERE health_status = 'CRITICAL') AS critical_relays
FROM relays;

CREATE VIEW v_fault_kpis AS
SELECT
  COUNT(*) FILTER (WHERE resolution_status IN ('OPEN', 'INVESTIGATING')) AS unresolved_faults,
  COUNT(*) FILTER (WHERE severity = 'CRITICAL' AND resolution_status IN ('OPEN','INVESTIGATING')) AS critical_alarms,
  COUNT(*) FILTER (WHERE "timestamp" > now() - INTERVAL '30 days') AS faults_last_30d
FROM faults;

CREATE VIEW v_alarm_kpis AS
SELECT
  COUNT(*) FILTER (WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED')) AS active_alarms,
  COUNT(*) FILTER (WHERE status = 'OPEN' AND priority = 'CRITICAL')       AS critical_open_alarms
FROM alarms;

-- One row per project's overall communication problem flag (any relay in the project offline/degraded).
CREATE VIEW v_project_comm_status AS
SELECT
  p.id AS project_id,
  BOOL_OR(r.comm_status IN ('OFFLINE', 'DEGRADED')) AS has_comm_problem,
  COUNT(r.id) FILTER (WHERE r.comm_status = 'OFFLINE') AS offline_relay_count
FROM projects p
LEFT JOIN substations s ON s.project_id = p.id
LEFT JOIN switchgear sg ON sg.substation_id = s.id
LEFT JOIN panels pnl ON pnl.switchgear_id = sg.id
LEFT JOIN relays r ON r.panel_id = pnl.id
GROUP BY p.id;

-- Fault density and relay health by city, for the national operations view / map drill-down.
CREATE VIEW v_city_summary AS
SELECT
  c.id AS city_id,
  c.name_en, c.name_fa,
  c.province_id,
  COUNT(DISTINCT p.id) AS project_count,
  COUNT(DISTINCT p.id) FILTER (WHERE p.status NOT IN ('COMPLETED','BLOCKED')) AS active_project_count,
  COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'RUNNING') AS running_project_count,
  COUNT(DISTINCT f.id) FILTER (WHERE f.severity = 'CRITICAL' AND f.resolution_status IN ('OPEN','INVESTIGATING')) AS critical_alarm_count,
  COUNT(DISTINCT f.id) FILTER (WHERE f."timestamp" > now() - INTERVAL '30 days') AS recent_fault_count
FROM cities c
LEFT JOIN projects p ON p.city_id = c.id
LEFT JOIN faults f ON f.city_id = c.id
GROUP BY c.id, c.name_en, c.name_fa, c.province_id;
