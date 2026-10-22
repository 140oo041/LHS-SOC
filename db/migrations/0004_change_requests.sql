-- Wiki change requests mirror pull requests on the GitHub repository. Git
-- holds the content; Atlas holds the review: who approved which exact head,
-- and who merged it. People are recorded by email, like audit_events, so a
-- record survives the person's account being removed.
CREATE TABLE IF NOT EXISTS change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pr_number integer NOT NULL UNIQUE,
  branch text NOT NULL,
  base_branch text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Null for a pull request opened on GitHub rather than in Atlas.
  author_email text,
  author_github_login text,
  status text NOT NULL CHECK (status IN ('open', 'merged', 'closed')),
  head_sha text NOT NULL,
  merge_commit_sha text,
  merged_by_email text,
  merged_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_change_per_branch ON change_requests (branch) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests (workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS change_request_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  reviewer_email text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('approved', 'changes_requested', 'commented')),
  -- The exact commit reviewed. A later push dismisses the review, so an
  -- approval never covers text the reviewer did not see.
  head_sha text NOT NULL,
  body text NOT NULL DEFAULT '',
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_change_request ON change_request_reviews (change_request_id, created_at);

-- GitHub retries deliveries; each is handled once.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
