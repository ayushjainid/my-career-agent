-- 0005: beta loop B1. Accounts, sessions, personal access tokens, invites, export and deletion.
--
-- The app role (mca_app) never reads these tables directly. Every access goes through the
-- SECURITY DEFINER functions below, which take hashes, never passwords or raw tokens, and
-- return only what the caller needs. A SQL-injection bug in a tenant query therefore cannot
-- list accounts or sessions.

CREATE TABLE mca.account (
  user_id        text PRIMARY KEY REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  email          text NOT NULL,
  password_hash  text NOT NULL,              -- pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
  created_at     timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_email_idx ON mca.account (lower(email));

CREATE TABLE mca.session (
  token_hash   text PRIMARY KEY,             -- sha256 of the cookie value, hex
  user_id      text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_user_idx ON mca.session (user_id);

-- Personal access tokens for agents and the MCP connector. Listed and revoked by their owner.
CREATE TABLE mca.api_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,                -- first characters, shown so the user can tell tokens apart
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
ALTER TABLE mca.api_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca.api_token FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mca.api_token USING (user_id = mca.current_user_id()) WITH CHECK (user_id = mca.current_user_id());
GRANT SELECT, INSERT, UPDATE ON mca.api_token TO mca_app;

CREATE TABLE mca.invite (
  code_hash   text PRIMARY KEY,
  note        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_by     text,
  used_at     timestamptz
);

CREATE TABLE mca.login_failure (
  email_hash  text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failure_idx ON mca.login_failure (email_hash, at);

-- ---------- functions (definer rights, fixed search_path) ----------

CREATE FUNCTION mca.auth_signup(p_user_id text, p_email text, p_password_hash text, p_invite_hash text, p_invite_required boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE lower(email) = lower(p_email)) THEN RETURN 'email_taken'; END IF;
  IF p_invite_required THEN
    UPDATE invite SET used_by = p_user_id, used_at = now() WHERE code_hash = p_invite_hash AND used_at IS NULL;
    IF NOT FOUND THEN RETURN 'bad_invite'; END IF;
  END IF;
  INSERT INTO app_user (user_id) VALUES (p_user_id);
  INSERT INTO account (user_id, email, password_hash) VALUES (p_user_id, p_email, p_password_hash);
  RETURN 'ok';
END $$;

-- Attach an email and password to an existing user (the POC founder signing up for real).
CREATE FUNCTION mca.auth_claim(p_user_id text, p_email text, p_password_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE user_id = p_user_id) THEN RETURN 'already_claimed'; END IF;
  IF EXISTS (SELECT 1 FROM account WHERE lower(email) = lower(p_email)) THEN RETURN 'email_taken'; END IF;
  INSERT INTO app_user (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  INSERT INTO account (user_id, email, password_hash) VALUES (p_user_id, p_email, p_password_hash);
  RETURN 'ok';
END $$;

-- Returns the stored hash for a login attempt, unless the address is locked out
-- (10 failures in 15 minutes). The caller verifies the password and reports the result.
CREATE FUNCTION mca.auth_login_lookup(p_email text, p_email_hash text)
RETURNS TABLE (user_id text, password_hash text, locked boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  SELECT a.user_id, a.password_hash,
         (SELECT count(*) >= 10 FROM login_failure f WHERE f.email_hash = p_email_hash AND f.at > now() - interval '15 minutes')
  FROM (SELECT 1) one LEFT JOIN account a ON lower(a.email) = lower(p_email)
$$;

CREATE FUNCTION mca.auth_login_failed(p_email_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  DELETE FROM login_failure WHERE at < now() - interval '1 day';
  INSERT INTO login_failure (email_hash) VALUES (p_email_hash);
$$;

CREATE FUNCTION mca.session_create(p_token_hash text, p_user_id text, p_days integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  DELETE FROM session WHERE user_id = p_user_id AND expires_at < now();
  INSERT INTO session (token_hash, user_id, expires_at) VALUES (p_token_hash, p_user_id, now() + make_interval(days => p_days));
$$;

-- Resolves a session cookie; slides the expiry at most once an hour.
CREATE FUNCTION mca.session_user(p_token_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
DECLARE uid text;
BEGIN
  UPDATE session SET last_seen_at = now(),
         expires_at = greatest(expires_at, now() + interval '30 days')
   WHERE token_hash = p_token_hash AND expires_at > now() AND last_seen_at < now() - interval '1 hour'
  RETURNING user_id INTO uid;
  IF uid IS NULL THEN
    SELECT user_id INTO uid FROM session WHERE token_hash = p_token_hash AND expires_at > now();
  END IF;
  RETURN uid;
END $$;

CREATE FUNCTION mca.session_end(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  DELETE FROM session WHERE token_hash = p_token_hash;
$$;

CREATE FUNCTION mca.token_user(p_token_hash text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  UPDATE api_token SET last_used_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL
  RETURNING user_id;
$$;

CREATE FUNCTION mca.account_email(p_user_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  SELECT email FROM account WHERE user_id = p_user_id;
$$;

CREATE FUNCTION mca.auth_password_hash(p_user_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  SELECT password_hash FROM account WHERE user_id = p_user_id;
$$;

-- Changing the password signs out every other session.
CREATE FUNCTION mca.auth_set_password(p_user_id text, p_password_hash text, p_keep_session text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  UPDATE account SET password_hash = p_password_hash, password_changed_at = now() WHERE user_id = p_user_id;
  DELETE FROM session WHERE user_id = p_user_id AND token_hash IS DISTINCT FROM p_keep_session;
$$;

CREATE FUNCTION mca.invite_create(p_code_hash text, p_note text, p_by text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
  INSERT INTO invite (code_hash, note, created_by) VALUES (p_code_hash, p_note, p_by);
$$;

-- Deletes everything a user owns. Called only after the API re-checked the password.
CREATE FUNCTION mca.account_delete(p_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
BEGIN
  DELETE FROM application_event WHERE user_id = p_user_id;   -- append-only for the app role, not for erasure
  DELETE FROM inbound_route WHERE user_id = p_user_id;
  DELETE FROM app_user WHERE user_id = p_user_id;           -- cascades to every tenant table, sessions and tokens
  UPDATE invite SET used_by = NULL WHERE used_by = p_user_id;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_signup(text,text,text,text,boolean)', 'auth_claim(text,text,text)', 'auth_login_lookup(text,text)',
    'auth_login_failed(text)', 'session_create(text,text,integer)', 'session_user(text)', 'session_end(text)',
    'token_user(text)', 'account_email(text)', 'auth_password_hash(text)', 'auth_set_password(text,text,text)',
    'invite_create(text,text,text)', 'account_delete(text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION mca.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION mca.%s TO mca_app', f);
  END LOOP;
END $$;
