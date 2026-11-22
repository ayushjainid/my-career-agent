-- One-time setup after the first migration: the two login roles the app connects as.
-- Run as the Neon owner:
--   psql "$DATABASE_OWNER_URL" -v api_password="$(openssl rand -base64 24)" \
--        -v loader_password="$(openssl rand -base64 24)" -f scripts/bootstrap_roles.sql
-- Then build DATABASE_URL (lv_api) and INGEST_DATABASE_URL (lv_loader) from the same host.
-- Never give the API the owner's connection string: row-level security depends on lv_app.
\set ON_ERROR_STOP on
CREATE ROLE lv_api LOGIN PASSWORD :'api_password';
GRANT lv_app TO lv_api;
CREATE ROLE lv_loader LOGIN PASSWORD :'loader_password';
GRANT lv_ingest TO lv_loader;
