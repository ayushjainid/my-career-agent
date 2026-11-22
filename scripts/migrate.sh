#!/usr/bin/env bash
# Apply db/migrations/*.sql in order, each once, each in its own transaction.
# Usage: DATABASE_OWNER_URL=postgres://... scripts/migrate.sh
# The ledger table records what ran, so re-running is safe.
set -euo pipefail
: "${DATABASE_OWNER_URL:?set DATABASE_OWNER_URL to the Neon owner connection string}"
cd "$(dirname "$0")/../db/migrations"

psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS public.lv_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in $(ls *.sql | sort); do
  done=$(psql "$DATABASE_OWNER_URL" -tAc "SELECT 1 FROM public.lv_migrations WHERE name = '$f'")
  if [ "$done" = "1" ]; then
    echo "skip  $f"
    continue
  fi
  echo "apply $f"
  # The ledger insert is in the same transaction as the migration: both land or neither does.
  { cat "$f"; echo; echo "INSERT INTO public.lv_migrations (name) VALUES ('$f');"; } |
    psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 --single-transaction -q -f -
done
echo "migrations up to date"
