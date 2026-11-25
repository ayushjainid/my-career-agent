-- Resume import: facts read from an uploaded resume are tagged, so a later import can replace them
-- without touching facts the person added by hand. The file itself is read in the browser and never stored.
ALTER TABLE mca.fact ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'resume'));
ALTER TABLE mca.fact ADD COLUMN IF NOT EXISTS location text;

CREATE TABLE IF NOT EXISTS mca.resume_import (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  file_name   text,
  format      text NOT NULL CHECK (format IN ('pdf', 'docx', 'tex', 'text')),
  counts      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mca.resume_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca.resume_import FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mca.resume_import;
CREATE POLICY tenant_isolation ON mca.resume_import USING (user_id = mca.current_user_id()) WITH CHECK (user_id = mca.current_user_id());
GRANT SELECT, INSERT ON mca.resume_import TO mca_app;
