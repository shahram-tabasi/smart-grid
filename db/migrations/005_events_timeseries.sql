-- 005_events_timeseries.sql
-- Unified Event Model storage. Hypertable when TimescaleDB is present, plain indexed table otherwise.
-- NOTE: no latitude/longitude/address column exists here — only province_id/city_id (see docs/ARCHITECTURE.md §9).

CREATE TABLE events (
  id                  UUID NOT NULL DEFAULT uuid_generate_v4(),
  "time"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  province_id         TEXT NOT NULL REFERENCES provinces(id),
  city_id             TEXT NOT NULL REFERENCES cities(id),
  panel_id            UUID REFERENCES panels(id),
  relay_id            UUID REFERENCES relays(id),
  event_type          TEXT NOT NULL,        -- PROTECTION_PICKUP | PROTECTION_TRIP | BREAKER_STATE_CHANGE | COMM_LOST | COMM_RESTORED | SCADA_ALARM | ENGINEER_NOTIFIED | ...
  protection_function protection_function_code,
  severity             event_severity NOT NULL DEFAULT 'INFO',
  breaker_status        breaker_status,
  source_protocol       source_protocol NOT NULL DEFAULT 'SYNTHETIC',
  message                TEXT NOT NULL,
  measurements           JSONB NOT NULL DEFAULT '{}'::jsonb, -- { current_A, voltage_kV, frequency_Hz, ... }
  acknowledged            BOOLEAN NOT NULL DEFAULT false,
  is_demo_data             BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id, "time")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('events', 'time', if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END $$;

CREATE INDEX idx_events_time ON events ("time" DESC);
CREATE INDEX idx_events_project ON events (project_id, "time" DESC);
CREATE INDEX idx_events_relay ON events (relay_id, "time" DESC);
CREATE INDEX idx_events_severity ON events (severity, "time" DESC);
CREATE INDEX idx_events_city ON events (city_id, "time" DESC);

-- Sequence-of-events / fault-timeline entries with millisecond precision, tied to a fault.
CREATE TABLE fault_timeline_entries (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fault_id     UUID NOT NULL, -- FK added in 006 after faults table exists
  "time"       TIMESTAMPTZ NOT NULL,
  sequence_no  INTEGER NOT NULL,
  description  TEXT NOT NULL,
  event_id     UUID
);
CREATE INDEX idx_fault_timeline_fault ON fault_timeline_entries(fault_id, sequence_no);

-- Raw telemetry samples (measurements outside of discrete events), for trend charts / load history.
CREATE TABLE telemetry_samples (
  "time"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  relay_id      UUID NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  current_a     NUMERIC(10,2),
  voltage_kv    NUMERIC(10,3),
  frequency_hz  NUMERIC(6,3),
  power_factor  NUMERIC(4,3),
  load_percent  NUMERIC(5,2),
  is_demo_data  BOOLEAN NOT NULL DEFAULT false
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('telemetry_samples', 'time', if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END $$;

CREATE INDEX idx_telemetry_relay_time ON telemetry_samples (relay_id, "time" DESC);
