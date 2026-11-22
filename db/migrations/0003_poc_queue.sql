-- 0003: POC loops P2 (profile) and P3 (daily queue).

-- When the user wants dream-company offers to land. Null = no holding back.
ALTER TABLE lv.app_user ADD COLUMN offer_window_start date;

-- One row per user per day the queue builder ran: what it queued, held back and excluded, and why.
-- This is what the P3 real-use check reviews ("every excluded job shows its reason").
CREATE TABLE lv.queue_run (
  user_id     text NOT NULL REFERENCES lv.app_user(user_id) ON DELETE CASCADE,
  run_date    date NOT NULL,
  builder     text NOT NULL,                 -- 'q-1'
  queued      integer NOT NULL,
  held_back   jsonb NOT NULL DEFAULT '[]',
  excluded    jsonb NOT NULL DEFAULT '[]',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, run_date)
);
ALTER TABLE lv.queue_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE lv.queue_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lv.queue_run
  USING (user_id = lv.current_user_id()) WITH CHECK (user_id = lv.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON lv.queue_run TO lv_app;

-- The nightly job must know which users exist without reading anyone's data. This returns ids
-- only, and only for users with at least one target; it bypasses RLS by design (definer rights).
CREATE FUNCTION lv.users_for_queue() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lv, pg_temp AS $$
  SELECT DISTINCT u.user_id FROM lv.app_user u JOIN lv.target t ON t.user_id = u.user_id
$$;
REVOKE ALL ON FUNCTION lv.users_for_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lv.users_for_queue() TO lv_app;
