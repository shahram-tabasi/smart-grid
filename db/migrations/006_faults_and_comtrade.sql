-- 006_faults_and_comtrade.sql

CREATE TABLE faults (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fault_code            TEXT NOT NULL UNIQUE,        -- e.g. FLT-2026-04213
  event_id              UUID,                         -- originating event, if any
  "timestamp"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  province_id           TEXT NOT NULL REFERENCES provinces(id),
  city_id               TEXT NOT NULL REFERENCES cities(id),
  panel_id              UUID REFERENCES panels(id),
  relay_id              UUID REFERENCES relays(id),
  protection_function   protection_function_code,
  fault_type            TEXT NOT NULL,                -- human label, e.g. "Feeder Overcurrent"
  severity               event_severity NOT NULL DEFAULT 'MEDIUM',
  breaker_status          breaker_status,
  current_a                NUMERIC(10,2),
  voltage_kv                NUMERIC(10,3),
  frequency_hz               NUMERIC(6,3),
  trip_status                  fault_trip_status NOT NULL DEFAULT 'NO_TRIP',
  acknowledgement_status         ack_status NOT NULL DEFAULT 'UNACKNOWLEDGED',
  acknowledged_by                 UUID REFERENCES users(id),
  acknowledged_at                  TIMESTAMPTZ,
  root_cause_status                   root_cause_status NOT NULL DEFAULT 'PENDING',
  assigned_engineer_id                 UUID REFERENCES users(id),
  resolution_status                      fault_resolution_status NOT NULL DEFAULT 'OPEN',
  is_demo_data                            BOOLEAN NOT NULL DEFAULT false,
  created_at                               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_faults_project ON faults(project_id);
CREATE INDEX idx_faults_relay ON faults(relay_id);
CREATE INDEX idx_faults_city ON faults(city_id);
CREATE INDEX idx_faults_severity ON faults(severity);
CREATE INDEX idx_faults_timestamp ON faults("timestamp" DESC);
CREATE INDEX idx_faults_resolution ON faults(resolution_status);

ALTER TABLE fault_timeline_entries
  ADD CONSTRAINT fk_fault_timeline_fault FOREIGN KEY (fault_id) REFERENCES faults(id) ON DELETE CASCADE;

-- COMTRADE / oscillography / disturbance records (§9 of the brief). Binary payload lives in object storage;
-- this row is the catalog entry + parsed channel metadata for the waveform viewer.
CREATE TABLE comtrade_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fault_id        UUID REFERENCES faults(id) ON DELETE CASCADE,
  relay_id        UUID REFERENCES relays(id),
  recorded_at     TIMESTAMPTZ NOT NULL,
  sample_rate_hz  INTEGER NOT NULL DEFAULT 4000,
  duration_ms     INTEGER NOT NULL DEFAULT 500,
  pre_fault_ms    INTEGER NOT NULL DEFAULT 100,
  post_fault_ms   INTEGER NOT NULL DEFAULT 400,
  channels        JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ name: "IA", unit: "A", type: "ANALOG" }, { name: "TRIP", type: "DIGITAL" }, ...]
  cfg_object_key  TEXT,   -- object storage key for .cfg
  dat_object_key  TEXT,   -- object storage key for .dat
  waveform_preview JSONB, -- downsampled series embedded for quick chart rendering without fetching the raw file
  is_demo_data     BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comtrade_fault ON comtrade_records(fault_id);
