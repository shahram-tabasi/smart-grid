-- 007_alarms.sql
-- Centralized alarm management with correlation grouping to avoid alarm flooding (spec §15).

CREATE TABLE alarm_correlation_groups (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  root_cause     TEXT,               -- filled in once AI/engineer identifies the shared root cause
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alarms (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alarm_code        TEXT NOT NULL UNIQUE,
  source_type       TEXT NOT NULL,        -- RELAY | COMMUNICATION | PROJECT | SCADA | SYSTEM
  project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
  relay_id          UUID REFERENCES relays(id),
  fault_id          UUID REFERENCES faults(id),
  priority          alarm_priority NOT NULL DEFAULT 'MEDIUM',
  status            alarm_status NOT NULL DEFAULT 'OPEN',
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  correlation_group_id UUID REFERENCES alarm_correlation_groups(id),
  assigned_to       UUID REFERENCES users(id),
  suppressed_by     UUID REFERENCES users(id),
  suppression_reason TEXT,
  acknowledged_by   UUID REFERENCES users(id),
  acknowledged_at   TIMESTAMPTZ,
  escalated_at      TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  is_demo_data      BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alarms_status ON alarms(status);
CREATE INDEX idx_alarms_priority ON alarms(priority);
CREATE INDEX idx_alarms_project ON alarms(project_id);
CREATE INDEX idx_alarms_correlation ON alarms(correlation_group_id);

CREATE TABLE alarm_comments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alarm_id    UUID NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  comment     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alarm_comments_alarm ON alarm_comments(alarm_id);
