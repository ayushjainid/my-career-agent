# Deploying the POC

The repository deploys itself: every push to `main` runs tests, applies new database migrations,
deploys the Worker and smoke-tests it (`.github/workflows/deploy.yml`). You set it up once.

## 1. Neon (database, EU)

1. Create a project at neon.tech in an EU region (for example Frankfurt). Copy the owner
   connection string: this is `DATABASE_OWNER_URL`.
2. Apply the migrations: `DATABASE_OWNER_URL=... scripts/migrate.sh`
   (or let the first deploy run do it).
3. Create the two login roles the app uses:
   `psql "$DATABASE_OWNER_URL" -v api_password=... -v loader_password=... -f scripts/bootstrap_roles.sql`
4. Build two connection strings from the owner string, swapping in the new users and passwords:
   `DATABASE_URL` (user `lv_api`) and `INGEST_DATABASE_URL` (user `lv_loader`).

## 2. Cloudflare (Worker)

1. Sign up (free plan is enough to start). Note the account id on the Workers overview page.
2. Create an API token from the "Edit Cloudflare Workers" template: `CLOUDFLARE_API_TOKEN`.
3. Your Worker URL will be `https://life-vector-api.<your-subdomain>.workers.dev`: `LV_URL`.

## 3. GitHub settings

In the repository, Settings > Secrets and variables > Actions:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | secret | from step 2 |
| `DATABASE_OWNER_URL` | secret | Neon owner string |
| `DATABASE_URL` | secret | `lv_api` string |
| `INGEST_DATABASE_URL` | secret | `lv_loader` string |
| `API_TOKENS` | secret | `yourname:<openssl rand -base64 32>` |
| `LV_TOKEN` | secret | the token part only |
| `LV_URL` | variable | the Worker URL |

Create an environment named `production` (Settings > Environments). Add a required reviewer if
you want to approve each deploy.

## 4. Deploy and check (loop P0)

Run **Deploy POC** from the Actions tab (or push to `main`). The last job runs `npm run smoke`
against the live Worker; P0 is done when it passes.

## 5. Load companies and sponsor data (loop P1)

1. Copy `jobs/companies.example.csv` to `jobs/companies.csv`, list your 100 target companies with
   their ATS board names, push. **Seed companies** runs on that push.
2. Run **US sponsor data** with the current LCA and PERM file URLs from the OFLC page.
3. Ingestion runs every 3 hours by itself. The daily queue is built at 06:05 UTC.

Then set up your profile with the commands in the README and start the P2 and P3 checks.
