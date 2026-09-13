-- 010_notifications_reports_audit.sql

CREATE TABLE notifications (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel               notification_channel NOT NULL DEFAULT 'DASHBOARD',
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL,
  status                notification_status NOT NULL DEFAULT 'PENDING',
  related_entity_type   TEXT,     -- 'FAULT' | 'ALARM' | 'PROJECT' | 'WORK_ORDER'
  related_entity_id     UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at               TIMESTAMPTZ,
  read_at               TIMESTAMPTZ
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_status ON notifications(status);

CREATE TABLE reports (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_type    TEXT NOT NULL, -- DAILY_OPERATIONS | WEEKLY_FAULT | MONTHLY_PROJECT | RELAY_HEALTH | CRITICAL_EVENT | PROJECT_DELAY | AI_RISK
  period_start   DATE,
  period_end     DATE,
  format         TEXT NOT NULL CHECK (format IN ('PDF', 'XLSX', 'CSV')),
  object_key     TEXT,
  generated_by   UUID REFERENCES users(id),
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_type ON reports(report_type, generated_at DESC);

-- Immutable audit log: application DB role is granted INSERT + SELECT only (see db/seed/grants.sql).
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  "time"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id       UUID REFERENCES users(id),
  action        TEXT NOT NULL,          -- LOGIN | ALARM_ACK | FAULT_ASSIGN | CONFIG_CHANGE | PROJECT_CHANGE | RELAY_INTEGRATION_CHANGE | PERMISSION_CHANGE | AI_RECOMMENDATION | HUMAN_APPROVAL | ...
  entity_type   TEXT,
  entity_id     TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address    INET
);
CREATE INDEX idx_audit_log_time ON audit_log("time" DESC);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, "time" DESC);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
