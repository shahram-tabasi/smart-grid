-- 003_projects.sql

CREATE TABLE projects (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code                        TEXT NOT NULL UNIQUE,             -- e.g. SUB-TEH-024
  name                        TEXT NOT NULL,
  customer_id                 UUID REFERENCES customers(id),
  province_id                 TEXT NOT NULL REFERENCES provinces(id),
  city_id                     TEXT NOT NULL REFERENCES cities(id),
  project_type                project_type NOT NULL DEFAULT 'MV_SWITCHGEAR',
  voltage_level               TEXT NOT NULL,                    -- e.g. '33kV', '132kV/33kV'
  project_manager_id          UUID REFERENCES users(id),
  technical_manager_id        UUID REFERENCES users(id),
  start_date                  DATE,
  expected_completion         DATE,
  actual_completion           DATE,
  status                      project_status NOT NULL DEFAULT 'PLANNING',

  engineering_progress        SMALLINT NOT NULL DEFAULT 0 CHECK (engineering_progress BETWEEN 0 AND 100),
  manufacturing_progress      SMALLINT NOT NULL DEFAULT 0 CHECK (manufacturing_progress BETWEEN 0 AND 100),
  fat_progress                SMALLINT NOT NULL DEFAULT 0 CHECK (fat_progress BETWEEN 0 AND 100),
  installation_progress       SMALLINT NOT NULL DEFAULT 0 CHECK (installation_progress BETWEEN 0 AND 100),
  commissioning_progress      SMALLINT NOT NULL DEFAULT 0 CHECK (commissioning_progress BETWEEN 0 AND 100),
  scada_integration_progress  SMALLINT NOT NULL DEFAULT 0 CHECK (scada_integration_progress BETWEEN 0 AND 100),
  relay_integration_progress  SMALLINT NOT NULL DEFAULT 0 CHECK (relay_integration_progress BETWEEN 0 AND 100),

  -- Weighted overall progress across the seven workstreams above.
  overall_progress SMALLINT GENERATED ALWAYS AS (
    ROUND(
      (engineering_progress + manufacturing_progress + fat_progress + installation_progress +
       commissioning_progress + scada_integration_progress + relay_integration_progress) / 7.0
    )::int
  ) STORED,

  health_score                SMALLINT CHECK (health_score BETWEEN 0 AND 100),
  requires_engineering_intervention BOOLEAN NOT NULL DEFAULT false,
  requires_field_service      BOOLEAN NOT NULL DEFAULT false,

  is_demo_data                BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_city ON projects(city_id);
CREATE INDEX idx_projects_province ON projects(province_id);

-- Historical health-score series (§12 "Project Health Score", trend charts).
CREATE TABLE project_health_scores (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  overall        SMALLINT NOT NULL CHECK (overall BETWEEN 0 AND 100),
  technical      SMALLINT NOT NULL CHECK (technical BETWEEN 0 AND 100),
  communication  SMALLINT NOT NULL CHECK (communication BETWEEN 0 AND 100),
  protection     SMALLINT NOT NULL CHECK (protection BETWEEN 0 AND 100),
  progress       SMALLINT NOT NULL CHECK (progress BETWEEN 0 AND 100),
  risk_level     TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH'))
);
CREATE INDEX idx_health_scores_project ON project_health_scores(project_id, computed_at DESC);
