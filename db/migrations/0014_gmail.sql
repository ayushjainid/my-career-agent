-- Gmail, as an alternative to a forwarding domain. The app holds a Google refresh token for the
-- gmail.metadata scope (senders, subjects, dates; never message bodies), encrypted with the same
-- AES-GCM scheme as AI keys and bound to the user id. Only job-related messages are stored.
CREATE TABLE IF NOT EXISTS mca.gmail_link (
  user_id       text PRIMARY KEY REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  email         text NOT NULL,
  token_ct      text NOT NULL,
  token_iv      text NOT NULL,
  history_id    text,                      -- NULL until the first sync has read the last 30 days
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_sync_at  timestamptz,
  last_error    text
);
ALTER TABLE mca.gmail_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca.gmail_link FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mca.gmail_link;
CREATE POLICY tenant_isolation ON mca.gmail_link USING (user_id = mca.current_user_id()) WITH CHECK (user_id = mca.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mca.gmail_link TO mca_app;

-- Where a stored email came from, and Gmail's message id so a message is never counted twice.
ALTER TABLE mca.inbound_email ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'forward' CHECK (source IN ('forward', 'gmail'));
ALTER TABLE mca.inbound_email ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS inbound_email_external ON mca.inbound_email (user_id, external_id) WHERE external_id IS NOT NULL;

-- The sync job must know who has Gmail linked without reading anyone's data: ids only.
CREATE OR REPLACE FUNCTION mca.gmail_users() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  SELECT user_id FROM mca.gmail_link
$$;
REVOKE ALL ON FUNCTION mca.gmail_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mca.gmail_users() TO mca_app;
