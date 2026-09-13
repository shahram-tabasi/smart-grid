-- 009_ai_and_chat.sql
-- AI is advisory-only: no table here has any relation to a control/write path against relays. See docs/ARCHITECTURE.md §8.

CREATE TABLE ai_analyses (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fault_id              UUID REFERENCES faults(id) ON DELETE CASCADE,
  event_id              UUID,
  summary               TEXT NOT NULL,
  probable_cause        TEXT NOT NULL,
  confidence_score       SMALLINT NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  evidence                JSONB NOT NULL DEFAULT '[]'::jsonb,       -- string[] of supporting evidence bullets
  related_event_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,       -- uuid[] as jsonb array
  recommended_action        TEXT NOT NULL,
  required_engineer_role      user_role,
  priority                      work_order_priority NOT NULL DEFAULT 'MEDIUM',
  model_version                 TEXT NOT NULL DEFAULT 'simorgh-rules-v1',
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_analyses_fault ON ai_analyses(fault_id);

-- Every AI recommendation that could translate into a real-world action requires an explicit,
-- audit-logged human approval before any downstream workflow (e.g. work order creation) proceeds.
CREATE TABLE ai_recommendation_approvals (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ai_analysis_id    UUID NOT NULL REFERENCES ai_analyses(id) ON DELETE CASCADE,
  decision          TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  approved_by       UUID NOT NULL REFERENCES users(id),
  approved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resulting_work_order_id UUID REFERENCES work_orders(id),
  notes             TEXT
);
CREATE INDEX idx_ai_approvals_analysis ON ai_recommendation_approvals(ai_analysis_id);

CREATE TABLE ai_chat_sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_chat_messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT NOT NULL,
  evidence     JSONB NOT NULL DEFAULT '[]'::jsonb, -- structured data backing the answer (project/relay/event ids, counts)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_chat_messages_session ON ai_chat_messages(session_id, created_at);
