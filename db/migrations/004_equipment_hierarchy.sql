-- 004_equipment_hierarchy.sql
-- Company -> Province -> City -> Project -> Substation -> Switchgear -> Panel -> Breaker -> Relay -> Protection Function

CREATE TABLE substations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  substation_type TEXT NOT NULL DEFAULT 'SUBSTATION', -- SUBSTATION | PLANT | INDUSTRIAL_FACILITY
  voltage_level   TEXT,
  is_demo_data    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_substations_project ON substations(project_id);

CREATE TABLE switchgear (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  substation_id   UUID NOT NULL REFERENCES substations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,          -- e.g. "33kV Switchgear"
  voltage_level   TEXT NOT NULL,
  switchgear_type TEXT NOT NULL DEFAULT 'AIS', -- AIS | GIS | RMU
  manufacturer    TEXT,
  is_demo_data    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_switchgear_substation ON switchgear(substation_id);

CREATE TABLE panels (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  switchgear_id   UUID NOT NULL REFERENCES switchgear(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,           -- e.g. "Feeder 01", "Transformer Feeder"
  panel_type      TEXT NOT NULL DEFAULT 'FEEDER', -- FEEDER | TRANSFORMER_FEEDER | INCOMER | BUS_COUPLER | CAPACITOR_BANK | MOTOR
  is_demo_data    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_panels_switchgear ON panels(switchgear_id);

CREATE TABLE breakers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  panel_id          UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  breaker_type      TEXT NOT NULL DEFAULT 'VCB', -- VCB | SF6 | ACB | GIS_CB
  rated_current_a   NUMERIC(10,2),
  status            breaker_status NOT NULL DEFAULT 'UNKNOWN',
  last_operation_at TIMESTAMPTZ,
  operation_count   INTEGER NOT NULL DEFAULT 0,
  is_demo_data      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_breakers_panel ON breakers(panel_id);

CREATE TABLE relays (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  panel_id              UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  breaker_id            UUID REFERENCES breakers(id),
  relay_code            TEXT NOT NULL UNIQUE,   -- e.g. "KER-F03"
  manufacturer          TEXT NOT NULL,           -- Siemens | ABB | Hitachi Energy | Schneider Electric | SEL | GE Multilin | Other
  model                 TEXT NOT NULL,           -- e.g. SIPROTEC 5, SEL-751, ABB REF615
  protocol              source_protocol NOT NULL DEFAULT 'IEC61850_MMS',
  serial_number         TEXT,
  firmware_version      TEXT,
  voltage_level         TEXT NOT NULL,

  comm_status           comm_status NOT NULL DEFAULT 'UNKNOWN',
  protection_status     TEXT NOT NULL DEFAULT 'IN_SERVICE', -- IN_SERVICE | BLOCKED | TEST_MODE | OUT_OF_SERVICE
  breaker_status         breaker_status NOT NULL DEFAULT 'UNKNOWN',
  active_setting_group   TEXT NOT NULL DEFAULT 'Group 1',

  last_communication_at TIMESTAMPTZ,
  last_event_at         TIMESTAMPTZ,
  last_trip_at          TIMESTAMPTZ,
  alarm_count            INTEGER NOT NULL DEFAULT 0,
  trip_count              INTEGER NOT NULL DEFAULT 0,
  health_score            SMALLINT NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  health_status            relay_health_status NOT NULL DEFAULT 'HEALTHY',

  is_demo_data           BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_relays_panel ON relays(panel_id);
CREATE INDEX idx_relays_comm_status ON relays(comm_status);
CREATE INDEX idx_relays_health_status ON relays(health_status);
CREATE INDEX idx_relays_manufacturer ON relays(manufacturer);

CREATE TABLE protection_functions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relay_id       UUID NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  function_code  protection_function_code NOT NULL,
  ansi_code      TEXT,                  -- e.g. '50/51', '87T', '67N'
  enabled        BOOLEAN NOT NULL DEFAULT true,
  pickup_value   NUMERIC(12,3),
  pickup_unit    TEXT,                  -- 'A', 'V', 'Hz', '%'
  time_delay_ms  INTEGER
);
CREATE INDEX idx_protection_functions_relay ON protection_functions(relay_id);

-- A convenience view giving the full drill-down path for every relay, used by hierarchy/breadcrumb endpoints.
CREATE VIEW v_equipment_hierarchy AS
SELECT
  r.id                AS relay_id,
  r.relay_code,
  r.manufacturer,
  r.model,
  p.id                AS project_id,
  p.code              AS project_code,
  p.name              AS project_name,
  c.id                AS city_id,
  c.name_en           AS city_name_en,
  c.name_fa           AS city_name_fa,
  pr.id               AS province_id,
  pr.name_en          AS province_name_en,
  pr.name_fa          AS province_name_fa,
  s.id                AS substation_id,
  s.name              AS substation_name,
  sg.id               AS switchgear_id,
  sg.name             AS switchgear_name,
  pnl.id              AS panel_id,
  pnl.name            AS panel_name,
  b.id                AS breaker_id,
  b.name              AS breaker_name
FROM relays r
JOIN panels pnl ON pnl.id = r.panel_id
JOIN switchgear sg ON sg.id = pnl.switchgear_id
JOIN substations s ON s.id = sg.substation_id
JOIN projects p ON p.id = s.project_id
JOIN cities c ON c.id = p.city_id
JOIN provinces pr ON pr.id = p.province_id
LEFT JOIN breakers b ON b.id = r.breaker_id;
