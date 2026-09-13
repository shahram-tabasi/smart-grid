-- 013_roles_and_grants.sql
-- Enforces "read vs control separation" and "AI is advisory only" at the database level, not just in
-- application code. Local-dev passwords here are placeholders — real deployments source them from a
-- credential vault (see docs/ARCHITECTURE.md §10).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simorgh_api') THEN
    CREATE ROLE simorgh_api LOGIN PASSWORD 'change_me_api';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simorgh_ai_readonly') THEN
    CREATE ROLE simorgh_ai_readonly LOGIN PASSWORD 'change_me_ai';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simorgh_edge_gateway') THEN
    CREATE ROLE simorgh_edge_gateway LOGIN PASSWORD 'change_me_edge';
  END IF;
END $$;

-- API service: normal read/write on operational tables, INSERT+SELECT only on audit_log (append-only),
-- and explicitly NO access at all to site_location_restricted by default (granted narrowly if ever needed).
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO simorgh_api;
REVOKE UPDATE, DELETE ON audit_log FROM simorgh_api;
GRANT INSERT, SELECT ON audit_log TO simorgh_api;
REVOKE ALL ON site_location_restricted FROM simorgh_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO simorgh_api;

-- AI service: SELECT-only, and no access whatsoever to the restricted-location table.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO simorgh_ai_readonly;
REVOKE ALL ON site_location_restricted FROM simorgh_ai_readonly;
REVOKE ALL ON refresh_tokens FROM simorgh_ai_readonly;
REVOKE ALL ON users FROM simorgh_ai_readonly; -- AI never sees credentials; project/relay ownership is enough for analysis

-- Edge Gateway: it only ever writes normalized events/telemetry and updates relay comm/health status —
-- it has no route to faults/work-orders/users and no route at all to site_location_restricted.
GRANT INSERT ON events, telemetry_samples TO simorgh_edge_gateway;
GRANT SELECT, UPDATE (comm_status, protection_status, breaker_status, last_communication_at, last_event_at,
                       last_trip_at, alarm_count, trip_count, health_score, health_status, updated_at)
  ON relays TO simorgh_edge_gateway;
GRANT UPDATE (status, last_operation_at, operation_count) ON breakers TO simorgh_edge_gateway;
