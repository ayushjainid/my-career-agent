-- On-demand queue refresh: fetching and ranking run as a GitHub Actions job (the Workers free plan's
-- 10 ms CPU limit is too small for them). The page records when it asked, and polls queue_run.
ALTER TABLE mca.app_user ADD COLUMN IF NOT EXISTS queue_requested_at timestamptz;
