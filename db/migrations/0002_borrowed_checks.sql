-- 0002: posting integrity, language and eligibility gates, form-field answers, follow-ups.
-- Several of these checks are adapted from ai-job-search (MIT). See THIRD_PARTY_NOTICES.md.

-- Integrity report for each posting, written by ingestion (postingGuard "pg-1").
-- level: clean | context | alarm | no_text. Advisory: an alarm shows a warning, it never hides the job.
ALTER TABLE lv.job ADD COLUMN integrity jsonb;
CREATE INDEX job_integrity_alarm_idx ON lv.job ((integrity->>'level')) WHERE integrity->>'level' = 'alarm';

-- Languages the user declares, for the language gate. Levels on the CEFR scale plus native.
CREATE TABLE lv.user_language (
  user_id   text NOT NULL REFERENCES lv.app_user(user_id) ON DELETE CASCADE,
  language  text NOT NULL,            -- lower-case English name: 'spanish'
  level     text NOT NULL CHECK (level IN ('A1','A2','B1','B2','C1','C2','native')),
  PRIMARY KEY (user_id, language)
);

-- Gate results and the form answers prepared for each application.
ALTER TABLE lv.application
  ADD COLUMN gates jsonb,                        -- [{gate, verdict, notes[]}]
  ADD COLUMN gate_verdict text CHECK (gate_verdict IN ('PASS','FLAG','FAIL'));

-- Free-text answers drafted for one application. Every answer cites the facts it relies on.
-- submitted_text is frozen when the user marks the application submitted: follow-ups may only
-- restate what is in it.
CREATE TABLE lv.application_answer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        text NOT NULL REFERENCES lv.app_user(user_id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES lv.application(id) ON DELETE CASCADE,
  label          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('self_intro','project','motivation','short_answer','other')),
  text           text NOT NULL,
  short_text     text,
  cited_fact_ids uuid[] NOT NULL DEFAULT '{}',
  max_chars      integer,
  max_words      integer,
  submitted_text text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_answer_app_idx ON lv.application_answer (application_id);

-- Follow-ups are application_event rows with kind 'followup_drafted' | 'followup_sent' |
-- 'thank_you_sent' | 'interview_held' | 'employer_reply'. The cap of two is enforced in core and here.
CREATE FUNCTION lv.followup_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'followup_sent' AND (
    SELECT count(*) FROM lv.application_event
    WHERE application_id = NEW.application_id AND kind = 'followup_sent') >= 2 THEN
    RAISE EXCEPTION 'at most two follow-ups per application';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_event_followup_cap BEFORE INSERT ON lv.application_event
  FOR EACH ROW EXECUTE FUNCTION lv.followup_cap();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_language','application_answer'] LOOP
    EXECUTE format('ALTER TABLE lv.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lv.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON lv.%I USING (user_id = lv.current_user_id()) WITH CHECK (user_id = lv.current_user_id())',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON lv.%I TO lv_app', t);
  END LOOP;
END $$;
