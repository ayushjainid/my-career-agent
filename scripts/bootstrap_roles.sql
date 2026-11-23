-- The two login roles the app connects as. Idempotent: creates them once, then re-applies the
-- passwords on every run (so they follow scripts/db-urls.mjs). Run as the Neon owner:
--   psql "$DATABASE_OWNER_URL" -v api_password=... -v loader_password=... -f scripts/bootstrap_roles.sql
-- Never give the API the owner's connection string: row-level security depends on lv_app.
\set ON_ERROR_STOP on
SELECT 'CREATE ROLE lv_api LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lv_api') \gexec
SELECT 'CREATE ROLE lv_loader LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lv_loader') \gexec
SELECT format('ALTER ROLE lv_api LOGIN PASSWORD %L', :'api_password') \gexec
SELECT format('ALTER ROLE lv_loader LOGIN PASSWORD %L', :'loader_password') \gexec
GRANT lv_app TO lv_api;
GRANT lv_ingest TO lv_loader;
