-- Phase 2: retrieval-augmented AI.
--
-- The Phase 1 AI was a deterministic rule engine behind the AI service contract. Phase 2 keeps that
-- contract and that engine (as the fallback and the offline mode) and adds retrieval so an
-- LLM-backed analysis can cite real, site-specific evidence instead of generalities.
--
-- THE ADVISORY-ONLY CONSTRAINT IS UNCHANGED AND IS ENFORCED AT THE DATABASE LAYER:
-- the simorgh_ai_readonly role has SELECT only (migration 013), and nothing added here grants it
-- more. An LLM cannot change a relay setting because the role it runs as cannot write to any
-- equipment table — no prompt can talk its way around a missing GRANT.
--
-- LOCATION PRIVACY: knowledge chunks are indexed with province/city only. The ingestion function
-- below refuses to store a chunk containing coordinate-shaped text, so retrieved context can never
-- reintroduce a precise location into an AI answer.

-- pgvector is optional: without it the platform runs the deterministic engine and keyword search.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not available; AI retrieval will fall back to full-text search. Install it to enable semantic retrieval.';
END $$;

-- ---------------------------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE knowledge_source_kind AS ENUM (
    'FAULT_HISTORY',      -- past faults and their confirmed root causes
    'WORK_ORDER',         -- what an engineer actually did about it
    'RELAY_MANUAL',       -- vendor documentation excerpts
    'PROTECTION_SETTING', -- setting rationale captured by the protection engineer
    'SITE_NOTE',          -- site-specific operational knowledge
    'STANDARD',           -- IEC/IEEE clauses relevant to a function
    'POST_MORTEM'         -- incident reviews
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind     knowledge_source_kind NOT NULL,
  -- What this chunk is about, so retrieval can be scoped to the relay/project in question.
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  province_id     TEXT REFERENCES provinces(id),
  city_id         TEXT REFERENCES cities(id),
  relay_id        UUID REFERENCES relays(id) ON DELETE CASCADE,
  fault_id        UUID REFERENCES faults(id) ON DELETE CASCADE,
  work_order_id   UUID REFERENCES work_orders(id) ON DELETE CASCADE,
  manufacturer    TEXT,
  model           TEXT,
  protection_function protection_function_code,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  -- Human-readable citation shown to the engineer alongside any AI conclusion drawn from it.
  citation        TEXT NOT NULL,
  is_demo_data    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add the embedding column only if pgvector loaded. 1536 dimensions matches the common
-- text-embedding-3-small size; change it here and in EMBEDDING_DIMENSIONS if you use another model.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
    -- IVFFlat needs training data to be useful; it is created but only pays off once populated.
    BEGIN
      CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
        ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not create ivfflat index yet (usually because the table is empty); it can be created later.';
    END;
  END IF;
END $$;

-- Full-text search is the fallback path when pgvector is absent, and a useful complement even when
-- it is present: exact relay codes and ANSI numbers are matched better lexically than semantically.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) STORED;
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_scope_idx ON knowledge_chunks (relay_id, project_id, source_kind);

COMMENT ON TABLE knowledge_chunks IS
  'Retrieval corpus for the AI service. Province/city only — no coordinates or addresses. Every chunk carries a citation so an AI conclusion can always be traced to its source.';

-- ---------------------------------------------------------------------------------------------
-- Guard: no coordinates in the corpus
-- ---------------------------------------------------------------------------------------------
-- Retrieved chunks are pasted into AI context. If a coordinate reached the corpus it could be
-- echoed into an answer, defeating the location-privacy rule everywhere else in the system. So the
-- corpus refuses to accept one.

CREATE OR REPLACE FUNCTION knowledge_chunks_reject_coordinates() RETURNS trigger AS $$
BEGIN
  IF NEW.content ~* '\m(lat(itude)?|lon(gitude)?|gps)\M\s*[:=]\s*-?\d{1,3}\.\d{3,}'
     OR NEW.content ~ '-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}'
  THEN
    RAISE EXCEPTION 'Knowledge chunk rejected: content appears to contain geographic coordinates. Only province and city may be recorded.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_chunks_no_coordinates ON knowledge_chunks;
CREATE TRIGGER knowledge_chunks_no_coordinates
  BEFORE INSERT OR UPDATE ON knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION knowledge_chunks_reject_coordinates();

-- ---------------------------------------------------------------------------------------------
-- AI provenance
-- ---------------------------------------------------------------------------------------------
-- Which engine produced an analysis, and what it was allowed to see. Recording this is what lets a
-- protection engineer decide how much weight to give an AI conclusion months later.

ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'simorgh-rules-v1';
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS retrieved_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
-- Set when the LLM path was attempted and failed, so a silently-degraded answer is still labelled.
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

COMMENT ON COLUMN ai_analyses.engine IS
  'Which analysis engine produced this row: simorgh-rules-v1 (deterministic) or an LLM identifier. Always advisory — see docs/ARCHITECTURE.md and the DB grants in migration 013.';

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content       TEXT NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieved_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  engine        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_chat_messages_session_idx ON ai_chat_messages (session_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
-- The AI role gains READ access to the corpus and nothing else. It still cannot write to any
-- equipment, project, relay, breaker or protection_function table — that is what makes
-- "AI is advisory only" a property of the system rather than a promise in a prompt.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simorgh_ai_readonly') THEN
    GRANT SELECT ON knowledge_chunks TO simorgh_ai_readonly;
    GRANT SELECT ON ai_chat_messages TO simorgh_ai_readonly;
    -- Explicitly re-assert the boundary in case a later migration is careless.
    REVOKE INSERT, UPDATE, DELETE ON knowledge_chunks FROM simorgh_ai_readonly;
    REVOKE ALL ON site_location_restricted FROM simorgh_ai_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simorgh_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_chunks TO simorgh_api;
    GRANT SELECT, INSERT ON ai_chat_messages TO simorgh_api;
    GRANT SELECT, INSERT, UPDATE ON relay_comm_paths, relay_comm_path_status, edge_gateways,
      disturbance_fetch_queue, point_map_profiles TO simorgh_api;
    GRANT SELECT, INSERT ON event_dead_letter TO simorgh_api;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO simorgh_api;
  END IF;
END $$;
