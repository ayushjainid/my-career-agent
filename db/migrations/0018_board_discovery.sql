-- Automatic company discovery: which sponsoring employers have been checked for a public job board,
-- and what was found. Misses are remembered so the same employer isn't re-checked for 90 days.
CREATE TABLE IF NOT EXISTS mca.board_discovery (
  employer_norm text PRIMARY KEY,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  found_vendor  text,
  found_board   text,
  company_id    uuid REFERENCES mca.company(id) ON DELETE SET NULL,
  tried         integer NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON mca.board_discovery TO mca_ingest;
-- Companies found this way are marked, so they're easy to review or remove.
ALTER TABLE mca.company ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'list' CHECK (source IN ('list', 'discovered', 'manual'));
