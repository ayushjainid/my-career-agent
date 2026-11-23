#!/usr/bin/env bash
# Apply db/migrations/*.sql in order, each once, each in its own transaction.
# Usage: DATABASE_OWNER_URL=postgres://... scripts/migrate.sh
# The ledger table records what ran, so re-running is safe.
set -euo pipefail
: "${DATABASE_OWNER_URL:?set DATABASE_OWNER_URL to the Neon owner connection string}"
# Pasted secrets often carry a trailing newline; a URL never contains whitespace.
DATABASE_OWNER_URL="$(printf %s "$DATABASE_OWNER_URL" | tr -d '[:space:]')"
cd "$(dirname "$0")/../db/migrations"

# Account, token and nightly-queue functions run with the owner's rights across users, so the
# owner must bypass row-level security (every Neon project's owner does since August 2023).
ok=$(psql "$DATABASE_OWNER_URL" -tAc "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
if [ "$ok" != "t" ]; then
  echo "The database owner role lacks BYPASSRLS. Run as an admin: ALTER ROLE <owner> BYPASSRLS;" >&2
  exit 1
fi

psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS public.mca_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in $(ls *.sql | sort); do
  done=$(psql "$DATABASE_OWNER_URL" -tAc "SELECT 1 FROM public.mca_migrations WHERE name = '$f'")
  if [ "$done" = "1" ]; then
    echo "skip  $f"
    continue
  fi
  echo "apply $f"
  # The ledger insert is in the same transaction as the migration: both land or neither does.
  { cat "$f"; echo; echo "INSERT INTO public.mca_migrations (name) VALUES ('$f');"; } |
    psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 --single-transaction -q -f -
done
echo "migrations up to date"
