# Deploying the POC

Every push to `main` deploys itself (`.github/workflows/deploy.yml`): tests, database
migrations, the app's database logins, the Worker, then a smoke test against the live URL.
You only create two accounts and add four secrets, once.

## 1. Neon (database)

1. Sign up at neon.tech and create a project in an **EU region** (for example AWS Frankfurt).
2. On the project dashboard, click **Connect** and copy the connection string for the owner role
   (`neondb_owner`). That is `DATABASE_OWNER_URL`.

## 2. Cloudflare (Worker)

1. Sign up at dash.cloudflare.com (the free plan is enough). Open **Workers & Pages** once so
   Cloudflare sets up your `workers.dev` subdomain.
2. Copy your **Account ID** (Workers & Pages overview, right side): `CLOUDFLARE_ACCOUNT_ID`.
3. My Profile > API Tokens > Create Token > template **Edit Cloudflare Workers** >
   choose your account > Create: `CLOUDFLARE_API_TOKEN`.

## 3. GitHub secrets

Repository > Settings > Secrets and variables > Actions > New repository secret:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 2 |
| `DATABASE_OWNER_URL` | from step 1 |
| `LV_TOKEN` | your API key: run `openssl rand -base64 32` and keep a copy |

The app's two database logins (`lv_api`, `lv_loader`) and their connection strings are derived
from the owner string at deploy time (`scripts/db-urls.mjs`); there is nothing else to store.

## 4. Deploy (loop P0)

Actions > **Deploy POC** > Run workflow. The run summary shows the Worker URL. P0 is done when the
last job, `smoke`, passes. Use the URL and `LV_TOKEN` for the README's profile commands.

## 5. Companies and sponsor data (loop P1)

1. Copy `jobs/companies.example.csv` to `jobs/companies.csv`, list your target companies with
   their ATS board names, and push. **Seed companies** runs on that push.
2. Run **US sponsor data** with the current LCA and PERM file URLs from the
   [OFLC performance page](https://www.dol.gov/agencies/eta/foreign-labor/performance).
3. Ingestion runs every 3 hours by itself; the daily queue is built at 06:05 UTC.

## Rotating credentials

- Database: reset the owner password in Neon, update `DATABASE_OWNER_URL`, re-run **Deploy POC**.
  The app logins get new passwords on the same run.
- API key: change `LV_TOKEN` and re-run **Deploy POC**.
