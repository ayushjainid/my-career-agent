-- 0006: beta loop B3. Personal forwarding addresses and email-driven stage changes.

-- The app may read its own route but creates it only through this function, which picks the
-- address server-side; one address per user.
CREATE FUNCTION mca.inbound_route_ensure(p_user_id text, p_candidate text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
DECLARE lp text;
BEGIN
  SELECT local_part INTO lp FROM inbound_route WHERE user_id = p_user_id;
  IF lp IS NOT NULL THEN RETURN lp; END IF;
  INSERT INTO inbound_route (local_part, user_id) VALUES (lower(p_candidate), p_user_id)
    ON CONFLICT (local_part) DO NOTHING RETURNING local_part INTO lp;
  RETURN lp; -- NULL on a (vanishingly rare) collision; the caller retries with a new candidate
END $$;
REVOKE ALL ON FUNCTION mca.inbound_route_ensure(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mca.inbound_route_ensure(text, text) TO mca_app;

ALTER TABLE mca.inbound_email
  ADD COLUMN company_norm text,
  ADD COLUMN application_id uuid REFERENCES mca.application(id) ON DELETE SET NULL,
  ADD COLUMN action text;   -- what the email changed: 'submitted', 'rejected', 'screen', or NULL

-- Freeze free-text answers whenever an application becomes submitted, whatever moved it (the web
-- app, an agent, or a forwarded confirmation email). Follow-ups may only restate this text.
CREATE FUNCTION mca.freeze_answers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mca.application_answer SET submitted_text = concat_ws(E'\n', text, short_text)
   WHERE application_id = NEW.id AND submitted_text IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER application_freeze_answers AFTER UPDATE OF state ON mca.application
  FOR EACH ROW WHEN (NEW.state = 'submitted' AND OLD.state IS DISTINCT FROM 'submitted')
  EXECUTE FUNCTION mca.freeze_answers();
