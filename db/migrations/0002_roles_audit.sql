-- Roles move from environment lists into memberships, which the baseline
-- created but nothing used. ATLAS_ADMIN_EMAILS stays as the bootstrap admin
-- list that the UI cannot demote.

-- Emails are compared lowercase everywhere; enforce it so two rows cannot
-- differ only by case.
UPDATE users SET email = lower(email) WHERE email <> lower(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  -- A revoked membership denies sign-in even when the person's domain is
  -- allowlisted, which is what makes revocation mean something.
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  action text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created ON audit_events (workspace_id, created_at DESC);
