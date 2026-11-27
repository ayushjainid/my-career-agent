-- Career-site detector (apps/api/src/detect.ts): which employers' websites were checked, the
-- official site found on Wikidata, and the job systems their careers pages link to.
CREATE TABLE IF NOT EXISTS mca.career_site_check (
  employer_norm text PRIMARY KEY,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  site          text,
  found         jsonb NOT NULL DEFAULT '[]'
);
GRANT SELECT, INSERT, UPDATE, DELETE ON mca.career_site_check TO mca_ingest;
