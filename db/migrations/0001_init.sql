-- My Career Agent: initial schema
-- Two planes:
--   1. Shared catalog (companies, jobs, sponsor records): no personal data, written by ingestion only.
--   2. Tenant data: everything personal, isolated per user with row-level security (RLS).
--
-- Runtime access pattern: the API connects as a login role that is a member of mca_app and,
-- inside each transaction, runs:  SELECT set_config('app.user_id', '<user id>', true);
-- Every tenant policy compares user_id with that setting. No setting => no rows.

-- ---------------------------------------------------------------------------
-- Roles (group roles; login users are created per environment and granted these)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mca_app') THEN
    CREATE ROLE mca_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mca_ingest') THEN
    CREATE ROLE mca_ingest NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS mca;
GRANT USAGE ON SCHEMA mca TO mca_app, mca_ingest;

-- Current user id from the transaction-local setting; NULL when unset.
CREATE OR REPLACE FUNCTION mca.current_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')
$$;

-- ---------------------------------------------------------------------------
-- Shared catalog
-- ---------------------------------------------------------------------------
CREATE TABLE mca.company (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  name_norm     text NOT NULL,                 -- normalised for matching (see jobs/my_career_agent_jobs/names.py)
  aliases       text[] NOT NULL DEFAULT '{}',  -- stored normalised, like name_norm
  domain        text,
  ats_vendor    text CHECK (ats_vendor IN ('greenhouse','lever','ashby','smartrecruiters','workable','workday','other')),
  ats_board     text,                          -- board token / site slug
  ats_region    text,                          -- e.g. 'eu' for api.eu.lever.co
  hq_country    text,
  last_fetched_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ats_vendor, ats_board)
);
CREATE INDEX company_name_norm_idx ON mca.company (name_norm);

CREATE TABLE mca.job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES mca.company(id) ON DELETE CASCADE,
  ats_vendor    text NOT NULL,
  ats_job_id    text NOT NULL,                 -- requisition id from the ATS: canonical job identity
  title         text NOT NULL,
  location_text text,
  remote_type   text CHECK (remote_type IN ('remote','hybrid','onsite','unknown')) DEFAULT 'unknown',
  country       text,
  pay_min       numeric,
  pay_max       numeric,
  pay_currency  text,
  pay_period    text CHECK (pay_period IN ('year','month','hour','unknown')) DEFAULT 'unknown',
  pay_source    text,                          -- 'structured' | 'text' | null
  posted_at     timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','stale')),
  apply_url     text,
  description_text text,
  requirements  jsonb,                         -- extracted once per job, shared by all users
  sponsorship_text_signal text CHECK (sponsorship_text_signal IN ('positive','negative','none')) DEFAULT 'none',
  UNIQUE (ats_vendor, company_id, ats_job_id)
);
CREATE INDEX job_company_idx ON mca.job (company_id);
CREATE INDEX job_status_seen_idx ON mca.job (status, last_seen_at DESC);

-- One row per employer x country x source x occupation x period, summarised from public files.
CREATE TABLE mca.sponsor_record (
  id             bigserial PRIMARY KEY,
  company_id     uuid REFERENCES mca.company(id) ON DELETE SET NULL,  -- filled by entity resolution
  country        text NOT NULL,              -- 'US','UK','CA','NL'
  source         text NOT NULL,              -- 'dol_lca','dol_perm','ukvi_register','esdc_lmia','ind_register'
  employer_name  text NOT NULL,
  employer_norm  text NOT NULL,
  employer_fein  text,
  occupation_code text,                      -- SOC / NOC / null
  period_start   date,
  period_end     date,
  filings        integer NOT NULL DEFAULT 0,
  certified      integer NOT NULL DEFAULT 0,
  denied         integer NOT NULL DEFAULT 0,
  withdrawn      integer NOT NULL DEFAULT 0,
  wage_levels    jsonb,                      -- e.g. {"I":3,"II":10,"III":4,"IV":1}
  extra          jsonb,                      -- source-specific fields (licence rating, etc.)
  source_file    text,
  refreshed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsor_employer_idx ON mca.sponsor_record (country, employer_norm);
CREATE INDEX sponsor_company_idx ON mca.sponsor_record (company_id);

-- Country policy rules (fees, lottery weighting, salary thresholds), reviewed by a human.
CREATE TABLE mca.policy_rule (
  id           bigserial PRIMARY KEY,
  country      text NOT NULL,
  rule_key     text NOT NULL,
  value        jsonb NOT NULL,
  source_url   text NOT NULL,
  reviewed_on  date NOT NULL,
  UNIQUE (country, rule_key)
);

GRANT SELECT ON mca.company, mca.job, mca.sponsor_record, mca.policy_rule TO mca_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mca.company, mca.job, mca.sponsor_record, mca.policy_rule TO mca_ingest;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mca TO mca_ingest;

-- ---------------------------------------------------------------------------
-- Tenant data (every table has user_id and RLS)
-- ---------------------------------------------------------------------------
CREATE TABLE mca.app_user (
  user_id       text PRIMARY KEY,             -- Better Auth user id
  home_country  text,
  locale        text DEFAULT 'en',
  daily_target  integer NOT NULL DEFAULT 10 CHECK (daily_target BETWEEN 0 AND 50),
  max_active_processes integer NOT NULL DEFAULT 8,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mca.work_auth (
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  country       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('citizen','permanent_resident','work_visa','needs_sponsorship')),
  visa_type     text,
  needs_new_cap_petition boolean NOT NULL DEFAULT false,  -- US: lottery needed
  min_lca_filings integer NOT NULL DEFAULT 5,
  min_perm_certified integer NOT NULL DEFAULT 3,
  PRIMARY KEY (user_id, country)
);

CREATE TABLE mca.target (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  country       text NOT NULL,
  title         text NOT NULL,
  occupation_code text,
  seniority     text CHECK (seniority IN ('entry','mid','senior','lead','executive')),
  pay_floor     numeric,
  pay_currency  text,
  locations     text[] NOT NULL DEFAULT '{}',
  remote_ok     boolean NOT NULL DEFAULT true
);

CREATE TABLE mca.fact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('role','achievement','skill','education','certification','project','language')),
  text          text NOT NULL,
  org           text,
  metric        text,
  skills        text[] NOT NULL DEFAULT '{}',
  start_date    date,
  end_date      date,
  verified      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mca.company_preference (
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES mca.company(id) ON DELETE CASCADE,
  tier          text CHECK (tier IN ('warmup','mid','dream')),
  block_mode    text CHECK (block_mode IN ('hard','soft')),
  block_reason  text,
  block_expires_at date,
  include_subsidiaries boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE mca.contact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  profile_url   text,
  email         text,
  company_name  text,
  company_id    uuid REFERENCES mca.company(id) ON DELETE SET NULL,
  position      text,
  connected_on  date,
  messages_count integer NOT NULL DEFAULT 0,
  last_message_at date,
  last_ask_at   date,
  imported_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mca.answer_bank_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  question_key  text NOT NULL,               -- e.g. 'us.work_authorized', 'us.needs_sponsorship_now'
  answer        text NOT NULL,
  sensitive     boolean NOT NULL DEFAULT false,
  reviewed_at   timestamptz,
  UNIQUE (user_id, question_key)
);

CREATE TABLE mca.application (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  job_id        uuid NOT NULL REFERENCES mca.job(id),
  state         text NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','approved','ready_for_review','submitted','screen','interview','offer','rejected','withdrawn','failed','skipped')),
  planned_date  date,
  submitted_at  timestamptz,
  fit_score     integer,
  rank_score    numeric,
  referral_contact_id uuid REFERENCES mca.contact(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)                   -- idempotency: one application per user per requisition
);

CREATE TABLE mca.application_event (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES mca.application(id) ON DELETE CASCADE,
  kind          text NOT NULL,               -- 'state_change','field_filled','email_detected', ...
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mca.inbound_email (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  from_address  text,
  subject       text,
  classification text,                       -- 'application_confirmation','job_alert','recruiter_reply','other'
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- RLS on every tenant table. FORCE makes it apply to the table owner too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user','work_auth','target','fact','company_preference','contact',
                           'answer_bank_entry','application','application_event','inbound_email']
  LOOP
    EXECUTE format('ALTER TABLE mca.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE mca.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON mca.%I USING (user_id = mca.current_user_id()) WITH CHECK (user_id = mca.current_user_id())',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON mca.%I TO mca_app', t);
  END LOOP;
END
$$;

GRANT USAGE, SELECT ON SEQUENCE mca.application_event_id_seq, mca.inbound_email_id_seq TO mca_app;

-- Append-only audit: the app may insert events but never change or delete them.
REVOKE UPDATE, DELETE ON mca.application_event FROM mca_app;

-- Inbound email routing: maps a personal forwarding address to a user before any user
-- context exists (the email handler has no session). Holds no other personal data.
CREATE TABLE mca.inbound_route (
  local_part    text PRIMARY KEY,             -- e.g. 'k7f3q9' in k7f3q9@in.mycareeragent.app
  user_id       text NOT NULL UNIQUE REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON mca.inbound_route TO mca_app;
GRANT INSERT, DELETE ON mca.inbound_route TO mca_ingest;
