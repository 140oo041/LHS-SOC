-- Spend controls that hold across every serverless instance. The previous
-- rate limiter lived in one process's memory, which bounds nothing once a
-- host runs several copies of Atlas at once.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS ai_usage_months (
  month date PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id bigserial PRIMARY KEY,
  -- A hash, not the email: usage is for budgeting, not for watching people.
  actor_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('chat', 'image', 'ingest')),
  model text,
  input_tokens integer,
  output_tokens integer,
  tool_calls integer,
  cost_micros bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events (created_at);

-- Ingestion now starts in one request and finishes in a later one (each
-- serverless call is time-limited), so a revision can be queued, and records
-- the provider batch it is waiting on. Replaced vector stores are deleted at
-- the provider and marked here.
ALTER TABLE knowledge_revisions
  ADD COLUMN IF NOT EXISTS provider_batch_id text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE knowledge_revisions DROP CONSTRAINT IF EXISTS knowledge_revisions_status_check;
ALTER TABLE knowledge_revisions ADD CONSTRAINT knowledge_revisions_status_check
  CHECK (status IN ('queued', 'running', 'ready', 'failed'));
CREATE UNIQUE INDEX IF NOT EXISTS one_live_revision_per_commit ON knowledge_revisions (workspace_id, git_revision)
  WHERE status IN ('queued', 'running', 'ready') AND deleted_at IS NULL;
