-- Coverage KPI history: after each measurement, one row per country, so progress can be tracked.
CREATE TABLE IF NOT EXISTS mca.coverage_snapshot (
  id          bigserial PRIMARY KEY,
  measured_at timestamptz NOT NULL DEFAULT now(),
  country     text NOT NULL,
  metrics     jsonb NOT NULL
);
GRANT SELECT, INSERT ON mca.coverage_snapshot TO mca_ingest;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mca TO mca_ingest;
