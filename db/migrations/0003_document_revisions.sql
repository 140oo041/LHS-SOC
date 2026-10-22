-- Documents gain real revisions. document_assets keeps describing the
-- current revision (so existing reads keep working) and document_revisions
-- holds every one, including the current.
CREATE TABLE IF NOT EXISTS document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  storage_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  note text NOT NULL DEFAULT '',
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision)
);

INSERT INTO document_revisions (document_id, revision, storage_key, filename, mime_type, byte_size, uploaded_by, created_at)
SELECT id, revision, storage_key, filename, mime_type, byte_size, owner_id, created_at FROM document_assets
ON CONFLICT DO NOTHING;

ALTER TABLE document_assets
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- An upload is reserved before the browser sends bytes to the bucket and
-- confirmed after. Reservations that are never confirmed are swept by the
-- daily cron, together with whatever bytes they left behind.
CREATE TABLE IF NOT EXISTS pending_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  uploader_email text NOT NULL,
  document_id uuid REFERENCES document_assets(id) ON DELETE CASCADE,
  title text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  declared_bytes bigint NOT NULL,
  block_ids text[] NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_uploads_expiry ON pending_uploads (expires_at);
