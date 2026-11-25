-- Forwarded email proposes; the person decides. A matched email no longer moves an application by
-- itself: it is stored as a pending suggestion ("Move Acme to Interviewing?") the person accepts or
-- ignores. Rows from before this migration were applied automatically and stay 'applied'.
ALTER TABLE mca.inbound_email ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'applied'
  CHECK (status IN ('applied', 'pending', 'accepted', 'ignored', 'info'));
-- {to, from} for a stage change; {company, title} for an application made outside the app;
-- {code, link} for Gmail's forwarding confirmation.
ALTER TABLE mca.inbound_email ADD COLUMN IF NOT EXISTS suggestion jsonb;
CREATE INDEX IF NOT EXISTS inbound_email_pending ON mca.inbound_email (user_id) WHERE status = 'pending';

-- Track an application made outside the app (e.g. on an employer's own site), from a confirmation
-- email. The company joins the shared catalog by name if new (no job board, so it's never fetched);
-- the job is private to this person: ats_vendor 'manual', status 'closed', so it never enters
-- anyone's queue. Returns the new (or existing) application id.
CREATE OR REPLACE FUNCTION mca.track_external(p_company text, p_norm text, p_title text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
DECLARE uid text := mca.current_user_id(); cid uuid; jid uuid; aid uuid;
BEGIN
  IF uid IS NULL OR coalesce(trim(p_company), '') = '' OR coalesce(trim(p_norm), '') = '' THEN RAISE EXCEPTION 'company required'; END IF;
  SELECT id INTO cid FROM company WHERE name_norm = p_norm OR p_norm = ANY (aliases) ORDER BY ats_board IS NULL LIMIT 1;
  IF cid IS NULL THEN
    INSERT INTO company (name, name_norm) VALUES (left(trim(p_company), 120), p_norm) RETURNING id INTO cid;
  END IF;
  INSERT INTO job (company_id, ats_vendor, ats_job_id, title, status, first_seen_at, last_seen_at)
    VALUES (cid, 'manual', 'u:' || uid || ':' || md5(lower(coalesce(p_title, ''))), left(coalesce(nullif(trim(p_title), ''), 'Role not named'), 200), 'closed', now(), now())
    ON CONFLICT (ats_vendor, company_id, ats_job_id) DO UPDATE SET last_seen_at = now()
    RETURNING id INTO jid;
  INSERT INTO application (user_id, job_id, state, submitted_at) VALUES (uid, jid, 'submitted', now())
    ON CONFLICT (user_id, job_id) DO UPDATE SET state = application.state
    RETURNING id INTO aid;
  RETURN aid;
END $$;
REVOKE ALL ON FUNCTION mca.track_external(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mca.track_external(text, text, text) TO mca_app;
