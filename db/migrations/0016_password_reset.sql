-- Forgot password. A reset link carries a random token; only its SHA-256 is stored. It works once,
-- for 30 minutes, and setting the new password signs out every session. Requests are limited to
-- 3 an hour per account, and the request route answers the same whether or not the email exists.
CREATE TABLE IF NOT EXISTS mca.password_reset (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS password_reset_user ON mca.password_reset (user_id, created_at);
ALTER TABLE mca.password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca.password_reset FORCE ROW LEVEL SECURITY;
-- No policy: the app role reaches it only through the functions below.

-- Returns the account's user id when a reset may be sent (account exists, under the hourly limit),
-- and records the token. NULL otherwise; the caller answers the same either way.
CREATE OR REPLACE FUNCTION mca.reset_request(p_email text, p_token_hash text, p_minutes integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
DECLARE uid text;
BEGIN
  SELECT user_id INTO uid FROM account WHERE lower(email) = lower(p_email);
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM password_reset WHERE user_id = uid AND created_at > now() - interval '1 hour') >= 3 THEN RETURN NULL; END IF;
  DELETE FROM password_reset WHERE expires_at < now() - interval '1 day';
  INSERT INTO password_reset (token_hash, user_id, expires_at) VALUES (p_token_hash, uid, now() + make_interval(mins => p_minutes));
  RETURN uid;
END $$;

-- Uses a token: valid, unexpired and unused, it sets the password, ends every session and every
-- other open reset link for the account, and returns the user id. NULL otherwise.
CREATE OR REPLACE FUNCTION mca.reset_complete(p_token_hash text, p_password_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
DECLARE uid text;
BEGIN
  UPDATE password_reset SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
   RETURNING user_id INTO uid;
  IF uid IS NULL THEN RETURN NULL; END IF;
  UPDATE account SET password_hash = p_password_hash, password_changed_at = now() WHERE user_id = uid;
  DELETE FROM session WHERE user_id = uid;
  UPDATE password_reset SET used_at = now() WHERE user_id = uid AND used_at IS NULL;
  RETURN uid;
END $$;

-- The account email behind a still-good link (NULL if expired, used or unknown): the page checks
-- the link before asking for a password, and the password rules need the email.
CREATE OR REPLACE FUNCTION mca.reset_lookup(p_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  SELECT a.email FROM password_reset r JOIN account a ON a.user_id = r.user_id
   WHERE r.token_hash = p_token_hash AND r.used_at IS NULL AND r.expires_at > now()
$$;

REVOKE ALL ON FUNCTION mca.reset_request(text, text, integer), mca.reset_complete(text, text), mca.reset_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mca.reset_request(text, text, integer), mca.reset_complete(text, text), mca.reset_lookup(text) TO mca_app;
