-- 0007: beta loop B4. A user's own AI provider key, encrypted with AES-GCM by the API before
-- it is stored (the database never sees it in plain text). One key per user.
CREATE TABLE mca.ai_key (
  user_id     text PRIMARY KEY REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('anthropic','openai')),
  model       text,
  ciphertext  text NOT NULL,   -- base64
  iv          text NOT NULL,   -- base64, 12 bytes
  last4       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mca.ai_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca.ai_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mca.ai_key USING (user_id = mca.current_user_id()) WITH CHECK (user_id = mca.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mca.ai_key TO mca_app;
