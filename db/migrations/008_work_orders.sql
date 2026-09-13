-- 008_work_orders.sql
-- Workflow: FAULT -> ANALYSIS -> WORK ORDER -> ASSIGNED -> FIELD_INSPECTION -> REPAIR -> TEST -> VERIFIED -> CLOSED

CREATE TABLE work_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_code     TEXT NOT NULL UNIQUE,
  fault_id            UUID REFERENCES faults(id),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  city_id             TEXT NOT NULL REFERENCES cities(id),
  equipment_description TEXT NOT NULL,
  problem             TEXT NOT NULL,
  priority            work_order_priority NOT NULL DEFAULT 'MEDIUM',
  assigned_engineer_id UUID REFERENCES users(id),
  due_date            DATE,
  status              work_order_status NOT NULL DEFAULT 'OPEN',
  notes               TEXT,
  resolution          TEXT,
  is_demo_data        BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ
);
CREATE INDEX idx_work_orders_status ON work_orders(status);
CREATE INDEX idx_work_orders_project ON work_orders(project_id);
CREATE INDEX idx_work_orders_priority ON work_orders(priority);

CREATE TABLE work_order_attachments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_id  UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  file_name      TEXT NOT NULL,
  object_key     TEXT NOT NULL,
  uploaded_by    UUID REFERENCES users(id),
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wo_attachments_wo ON work_order_attachments(work_order_id);

CREATE TABLE work_order_status_history (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_id  UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  from_status    work_order_status,
  to_status      work_order_status NOT NULL,
  changed_by     UUID REFERENCES users(id),
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  note           TEXT
);
CREATE INDEX idx_wo_status_history_wo ON work_order_status_history(work_order_id, changed_at);
