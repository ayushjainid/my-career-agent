-- 0008: beta loop B5. Pay benchmarks from public LCA filings (shared catalog, no personal data).
CREATE TABLE mca.pay_benchmark (
  id            bigserial PRIMARY KEY,
  country       text NOT NULL,
  employer_norm text NOT NULL,          -- '*' = every employer (the market for that title family)
  company_id    uuid REFERENCES mca.company(id) ON DELETE SET NULL,
  title_family  text NOT NULL,
  n             integer NOT NULL,
  p25           integer NOT NULL,
  p50           integer NOT NULL,
  p75           integer NOT NULL,
  currency      text NOT NULL,
  source_file   text NOT NULL,
  period_end    date
);
CREATE INDEX pay_benchmark_lookup_idx ON mca.pay_benchmark (country, title_family, company_id);
GRANT SELECT ON mca.pay_benchmark TO mca_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mca.pay_benchmark TO mca_ingest;
GRANT USAGE, SELECT ON SEQUENCE mca.pay_benchmark_id_seq TO mca_ingest;
