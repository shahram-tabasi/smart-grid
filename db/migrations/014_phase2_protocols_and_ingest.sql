-- Phase 2: full protocol catalogue, event provenance, ingest durability, and comms supervision.
--
-- LOCATION PRIVACY IS UNCHANGED BY THIS MIGRATION. No table created or altered here gains a
-- coordinate, address or precise-location column. site_location_restricted (migration 011) remains
-- the only table in the schema permitted to hold one.

-- ---------------------------------------------------------------------------------------------
-- 1. Widen the protocol vocabulary
-- ---------------------------------------------------------------------------------------------
-- The Phase 1 enum listed nine protocols. Phase 2 supports the full catalogue in
-- packages/shared/src/protocols.ts. The legacy value 'DNP3' is deliberately retained (rather than
-- renamed) so events already stored under it remain valid; new data uses DNP3_TCP / DNP3_SERIAL.

ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'IEC61850_SV';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'IEC61850_FILE';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'IEC60870_5_101';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'IEC60870_5_103';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'DNP3_TCP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'DNP3_SERIAL';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'MODBUS_RTU';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'MODBUS_ASCII';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'MQTT_SPARKPLUG_B';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'WEBSOCKET';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'SEL_ASCII';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'SPA_BUS';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'COURIER';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'GE_EGD';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'PROFIBUS_DP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'SNMP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'SYSLOG';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'FTP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'SFTP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'TFTP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'NTP';
ALTER TYPE source_protocol ADD VALUE IF NOT EXISTS 'PTP_1588';

-- events.event_type is a TEXT column (see migration 005), not an enum, so the Phase 2 event types
-- (DISTURBANCE_RECORD_AVAILABLE, DEVICE_SELF_TEST_FAILED, TIME_SYNC_DEGRADED, SECURITY_LOG_EVENT,
-- GOOSE_SEQUENCE_ANOMALY) need no DDL. The authoritative list lives in the UnifiedEvent type in
-- packages/shared/src/unified-event.ts.

-- ---------------------------------------------------------------------------------------------
-- 2. Time-sync quality
-- ---------------------------------------------------------------------------------------------
-- The honesty mechanism for the millisecond fault timeline: a Modbus-derived event is stamped by
-- the gateway, a GOOSE message from a PTP-synced station is accurate to microseconds, and the UI
-- must be able to tell an engineer which is which rather than presenting both as equally precise.

DO $$ BEGIN
  CREATE TYPE time_sync_quality AS ENUM (
    'SUB_MICROSECOND', 'SUB_MILLISECOND', 'MILLISECOND', 'SECOND', 'GATEWAY_STAMPED', 'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Event provenance
-- ---------------------------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN IF NOT EXISTS time_sync_quality time_sync_quality NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_path_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_reference TEXT;

-- The gateway-assigned event identifier. Distinct from events.id (our surrogate key): this is the
-- id the producing gateway generated, and it is what makes redelivery detectable.
ALTER TABLE events ADD COLUMN IF NOT EXISTS gateway_event_id TEXT;

-- Redelivery from a gateway after a network wobble must not create a duplicate trip.
-- The index includes "time" because on a TimescaleDB hypertable every unique index must contain
-- the partitioning column; the gateway resends an identical (id, timestamp) pair, so this still
-- collapses retries to one row. On a plain table it behaves the same way.
CREATE UNIQUE INDEX IF NOT EXISTS events_gateway_event_id_uniq
  ON events (gateway_event_id, "time")
  WHERE gateway_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_time_sync_quality_idx ON events (time_sync_quality)
  WHERE time_sync_quality IN ('GATEWAY_STAMPED', 'UNKNOWN', 'SECOND');

COMMENT ON COLUMN events.time_sync_quality IS
  'How much this row''s timestamp can be trusted. Set from the protocol and the measured clock offset at the source site. The fault timeline must surface this rather than implying uniform precision.';

-- ---------------------------------------------------------------------------------------------
-- 4. Communication paths (the redundancy model)
-- ---------------------------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE comm_path_role AS ENUM ('PRIMARY', 'BACKUP', 'AUXILIARY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE comm_path_state AS ENUM ('CONNECTED', 'CONNECTING', 'DISCONNECTED', 'FAILED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS relay_comm_paths (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relay_id              UUID NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  path_id               TEXT NOT NULL,
  protocol              source_protocol NOT NULL,
  role                  comm_path_role NOT NULL DEFAULT 'PRIMARY',
  -- Network location of the DEVICE on the OT network. This is an equipment address, not a
  -- geographic location, and is visible only to users with the equivalent of engineering access.
  host                  TEXT,
  port                  INTEGER,
  serial_device         TEXT,
  serial_baud_rate      INTEGER,
  serial_link_address   INTEGER,
  -- Credentials are ALWAYS a vault reference. A secret is never stored in this table.
  credentials_ref       TEXT,
  addressing            JSONB NOT NULL DEFAULT '{}'::jsonb,
  poll_interval_ms      INTEGER,
  supervision_timeout_s INTEGER NOT NULL DEFAULT 60,
  point_map_profile_id  TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (relay_id, path_id)
);

CREATE INDEX IF NOT EXISTS relay_comm_paths_relay_idx ON relay_comm_paths (relay_id);
CREATE INDEX IF NOT EXISTS relay_comm_paths_protocol_idx ON relay_comm_paths (protocol);

COMMENT ON TABLE relay_comm_paths IS
  'Every configured way to reach a relay. A relay commonly has several (fast primary, slower backup on a different protocol, auxiliary channels for files/health/time). The gateway supervisor fails over down this list by role.';
COMMENT ON COLUMN relay_comm_paths.credentials_ref IS
  'Reference into the credential vault. Storing an actual secret in this column is a security defect.';

-- Live status of each path, updated by the gateway supervisor.
CREATE TABLE IF NOT EXISTS relay_comm_path_status (
  path_row_id           UUID PRIMARY KEY REFERENCES relay_comm_paths(id) ON DELETE CASCADE,
  state                 comm_path_state NOT NULL DEFAULT 'DISCONNECTED',
  state_since           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_data_at          TIMESTAMPTZ,
  last_error_message    TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  latency_ms            INTEGER,
  clock_offset_ms       DOUBLE PRECISION,
  time_sync_quality     time_sync_quality NOT NULL DEFAULT 'UNKNOWN',
  frames_received       BIGINT NOT NULL DEFAULT 0,
  frames_rejected       BIGINT NOT NULL DEFAULT 0,
  is_active_path        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- 5. Gateway registry
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_gateways (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_id      TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  province_id     TEXT REFERENCES provinces(id),
  city_id         TEXT REFERENCES cities(id),
  software_version TEXT,
  last_seen_at    TIMESTAMPTZ,
  last_sequence   BIGINT NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE edge_gateways IS
  'Registered edge gateways. Province/city only — a gateway is located to the same granularity as everything else in the management interface.';

-- ---------------------------------------------------------------------------------------------
-- 6. Ingest durability
-- ---------------------------------------------------------------------------------------------

-- Anything that could not be processed. Dropping an unparseable message silently is how a real
-- trip goes unrecorded, so failures are kept and surfaced in the admin UI.
CREATE TABLE IF NOT EXISTS event_dead_letter (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  gateway_id   TEXT,
  reason       TEXT NOT NULL,
  raw_payload  JSONB NOT NULL,
  reviewed     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS event_dead_letter_unreviewed_idx ON event_dead_letter (received_at DESC) WHERE NOT reviewed;

-- Work queue for pulling COMTRADE sets after a relay signals a record is available.
DO $$ BEGIN
  CREATE TYPE disturbance_fetch_status AS ENUM ('PENDING', 'FETCHING', 'STORED', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS disturbance_fetch_queue (
  id              BIGSERIAL PRIMARY KEY,
  relay_id        UUID NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  remote_id       TEXT NOT NULL,
  source_protocol source_protocol NOT NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          disturbance_fetch_status NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  comtrade_record_id UUID REFERENCES comtrade_records(id) ON DELETE SET NULL,
  UNIQUE (relay_id, remote_id)
);
CREATE INDEX IF NOT EXISTS disturbance_fetch_queue_pending_idx ON disturbance_fetch_queue (requested_at) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------------------------
-- 7. Point-map profiles
-- ---------------------------------------------------------------------------------------------
-- Vendor neutrality depends on address maps being DATA, not code. Built-in profiles ship with the
-- application; sites add and override their own here.

CREATE TABLE IF NOT EXISTS point_map_profiles (
  profile_id    TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  manufacturer  TEXT NOT NULL,
  models        TEXT[] NOT NULL DEFAULT '{}',
  points        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_built_in   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE point_map_profiles IS
  'Register/point maps per relay model and protocol. Keeping these as data rather than code is what makes the platform vendor-neutral: supporting a new relay model is a configuration change, not a release.';

-- ---------------------------------------------------------------------------------------------
-- 8. Views
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_relay_comm_health AS
SELECT
  r.id                AS relay_id,
  r.relay_code,
  r.manufacturer,
  r.model,
  p.id                AS project_id,
  p.code              AS project_code,
  pr.name_en          AS province_name_en,
  c.name_en           AS city_name_en,
  COUNT(cp.id)                                              AS configured_paths,
  COUNT(cp.id) FILTER (WHERE cps.state = 'CONNECTED')       AS connected_paths,
  COUNT(cp.id) FILTER (WHERE cp.role = 'PRIMARY')           AS primary_paths,
  BOOL_OR(cps.is_active_path)                               AS has_active_path,
  MAX(cps.last_data_at)                                     AS last_data_at,
  -- Redundancy is only real if a non-primary path is actually usable.
  (COUNT(cp.id) FILTER (WHERE cp.role <> 'AUXILIARY' AND cps.state = 'CONNECTED') > 1) AS is_redundant,
  MIN(cps.time_sync_quality::text)                          AS worst_time_sync_quality
FROM relays r
JOIN panels pnl      ON pnl.id = r.panel_id
JOIN switchgear sg   ON sg.id = pnl.switchgear_id
JOIN substations sub ON sub.id = sg.substation_id
JOIN projects p      ON p.id = sub.project_id
JOIN provinces pr    ON pr.id = p.province_id
JOIN cities c        ON c.id = p.city_id
LEFT JOIN relay_comm_paths cp        ON cp.relay_id = r.id AND cp.enabled
LEFT JOIN relay_comm_path_status cps ON cps.path_row_id = cp.id
GROUP BY r.id, r.relay_code, r.manufacturer, r.model, p.id, p.code, pr.name_en, c.name_en;

COMMENT ON VIEW v_relay_comm_health IS
  'Per-relay communication health including redundancy. A relay with only one usable path is a single point of monitoring failure and is surfaced as such.';

CREATE OR REPLACE VIEW v_protocol_usage AS
SELECT
  cp.protocol,
  COUNT(DISTINCT cp.relay_id)                          AS relay_count,
  COUNT(*)                                             AS path_count,
  COUNT(*) FILTER (WHERE cps.state = 'CONNECTED')      AS connected_count,
  COUNT(*) FILTER (WHERE cps.state = 'FAILED')         AS failed_count,
  AVG(cps.latency_ms)                                  AS avg_latency_ms
FROM relay_comm_paths cp
LEFT JOIN relay_comm_path_status cps ON cps.path_row_id = cp.id
WHERE cp.enabled
GROUP BY cp.protocol;
