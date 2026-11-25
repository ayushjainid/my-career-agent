# Deploying My Career Agent

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
| `MCA_TOKEN` | your API key: run `openssl rand -base64 32` and keep a copy |

The app's two database logins (`mca_api`, `mca_loader`) and their connection strings are derived
from the owner string at deploy time (`scripts/db-urls.mjs`); there is nothing else to store.

## 4. Deploy (loop P0)

Actions > **Deploy** > Run workflow. The run summary shows the Worker URL. The deploy is good when the
last job, `smoke`, passes.

## 5. Companies and sponsor data (loop P1)

1. Copy `jobs/companies.example.csv` to `jobs/companies.csv`, list your target companies with
   their ATS board names, and push. **Seed companies** runs on that push.
2. Run **US sponsor data** with the current LCA and PERM file URLs from the
   [OFLC performance page](https://www.dol.gov/agencies/eta/foreign-labor/performance).
   DOL now serves them from `https://www.dol.gov/media/`, e.g.
   `https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q4.xlsx` and
   `https://www.dol.gov/media/PERM_Disclosure_Data_FY2026_Q4.xlsx` (loaded on 25 Nov 2026). Set them as
   the `LCA_URL` and `PERM_URL` repository variables so the monthly run keeps them; update them each quarter.
3. Job fetching and queue building run on GitHub Actions (**Fetch jobs and build queues**,
   `.github/workflows/jobs.yml`): every 3 hours it fetches every company's job board, and at 06:05 UTC
   it also builds everyone's queue. They don't run on the Worker because the Workers free plan allows
   10 ms of CPU per request and one large job board takes about 850 ms.

### "Build today's queue" on demand

The Today page's button starts that GitHub job for the person who clicked it (fetch boards not
fetched in the last hour, then build their queue), and the page shows the new queue 1 to 3 minutes
later. It needs a token that may start workflows:

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token.
   Repository access: only `ayushjainid/my-career-agent`. Permissions: **Actions: Read and write**
   (nothing else). Pick an expiry and note it.
2. Add it as the repository secret `GH_DISPATCH_TOKEN` (Settings → Secrets and variables → Actions).
3. Run **Deploy** (or push). The deploy copies it to the Worker as `GITHUB_DISPATCH_TOKEN`.

Until then the button ranks what is already in the catalog, and new jobs arrive every 3 hours.

## Rotating credentials

- Database: reset the owner password in Neon, update `DATABASE_OWNER_URL`, re-run **Deploy**.
  The app logins get new passwords on the same run. `AI_KEY_SECRET` is derived from the same string,
  so people who saved their own AI key are asked to add it again.
- API key: change `MCA_TOKEN` and re-run **Deploy**.

## Beta accounts (loop B1)

Sign-up is invite-only (`INVITE_REQUIRED = "true"` in `apps/api/wrangler.toml`).

1. Open the Worker URL, choose **Sign in with an access token**, and paste `MCA_TOKEN`. That's
   the `founder` account, which holds the data you set up during the POC.
2. In **Settings > Account**, add an email and password. From then on, sign in normally.
3. Create invite codes for beta users (the founder is the admin through `ADMIN_USER_IDS`):

   ```sh
   curl -s -X POST "$MCA_URL/api/admin/invites" -H "authorization: Bearer $MCA_TOKEN" \
     -H 'content-type: application/json' -d '{"count": 5}'
   ```

## Database owner needs BYPASSRLS

The account, invite and email-routing functions run as the table owner over row-level-security
tables. Neon's owner role has `BYPASSRLS`; `scripts/migrate.sh` stops with the fix
(`ALTER ROLE <owner> BYPASSRLS`) if yours doesn't.

## Sign-in cost and the Workers plan

Passwords are hashed with PBKDF2-SHA256. `PBKDF2_ITERATIONS = "50000"` takes about 7 ms of CPU,
inside the Free plan's 10 ms per request. On Workers Paid, raise it to `"100000"`. Existing
passwords are re-hashed at the next sign-in.

## Email forwarding (loop B3)

Forwarding addresses need a domain on Cloudflare:

1. Add a domain to Cloudflare and turn on **Email Routing** for it, or use a subdomain such as
   `in.example.com`.
2. Create a catch-all rule: **Send to a Worker**, choosing `my-career-agent-api`.
3. Set `INBOUND_DOMAIN` in `apps/api/wrangler.toml` to that domain and push.

Until then, the Follow-ups page says forwarding isn't switched on, and stages are updated by hand.

## AI connectors (loop B4)

Each user creates a token in **Settings > AI connectors**. Any MCP client that supports HTTP servers
with headers can use it:

```json
{ "mcpServers": { "my-career-agent": { "type": "http", "url": "https://<worker-url>/mcp",
  "headers": { "Authorization": "Bearer mca_pat_..." } } } }
```

claude.ai web connectors need OAuth, which comes later. Connectors can't mark an application
submitted.

## Billing (loop B6)

Billing is built but off for the free beta. To turn it on, set `BILLING_ENABLED = "true"`,
`STRIPE_PRICE_ID` and `FREE_DAILY_LIMIT` as vars, then add the `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` secrets and point a Stripe webhook at `/api/stripe/webhook`. The privacy
notice in the app and in `docs/privacy/` is a draft. It needs the controller's name and contact
details and a legal review before the beta opens widely.

## UK, Canada and Ireland sponsor data (loops B7, B8)

Run **UK and Canada sponsor data** with the current register file URLs: the Home Office register of
licensed sponsors (CSV) and ESDC's positive LMIA employer list. It also runs weekly when the
`UK_REGISTER_URL` and `CA_LMIA_URL` repository variables are set.

### Ireland (loop B8)

The same workflow (now **UK, Canada and Ireland sponsor data**) downloads DETE's "permits issued to
companies" spreadsheets for this year and last from enterprise.gov.ie. If DETE renames the file, set
the `IE_URL` repository variable to the new link. Italy has no public sponsor list, so there is nothing
to load: Milan jobs are judged by what the posting says.

Permit pay minimums live in `PERMIT_MINIMUMS` in `packages/core/src/countries.ts`, each with the date
it took effect. Check them when Ireland or Italy announce new thresholds (Ireland usually reviews in
the spring; Italy's Blue Card figure is set by decree and the stored one is approximate).

To get Dublin and Milan jobs into the queue, add companies hiring there to `jobs/companies.csv` (see `jobs/companies.example.csv`) with
their Greenhouse, Lever or Ashby board, then run the company seed.
