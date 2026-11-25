# My Career Agent

A tool-neutral job-search agent: it finds and ranks roles, checks visa sponsorship history, plans
when to apply where, and prepares an apply packet that any tool (or the built-in copy-assist panel)
can use. The user always submits.

Design: see the "My Career Agent — Technical Design" doc. The POC (P0–P5) and the beta loops (B1–B7) are built; see Beta progress below.

## What works today

| Area | Where | Status |
| --- | --- | --- |
| Postgres schema with row-level security (tenant isolation) | `db/migrations/` | Done, tested in an in-process Postgres |
| Deterministic requirement extraction, resume scoring (F2), sponsorship scoring | `packages/core` | Done, tested |
| Blacklist with expiry and subsidiaries (F4), ranking (F7), timing planner (F9) | `packages/core` | Done, tested |
| Pay parsing from posting text (USD, GBP, EUR, CAD; yearly/hourly) | `packages/core/src/pay.ts` | Done, tested |
| Greenhouse, Lever (US + EU), Ashby feed adapters and board diffing | `apps/api/src/ats` | Done, tested with doc-shaped fixtures |
| Scheduled ingestion into the shared catalog | `apps/api/src/ingest.ts` | Written; needs a live Neon database to exercise |
| Inbound email: classify alerts, confirmations, rejections; auto-mark submitted | `apps/api/src/email.ts` | Classifier tested; handler needs Email Routing to exercise |
| API: manual scoring, queue, apply packets, status changes, company preferences | `apps/api/src/routes.ts` | Written; dev auth only (see below) |
| US sponsor data from DOL LCA + PERM files | `jobs/my_career_agent_jobs/us_dol.py` | Done, tested; layout changes fail loudly |
| Company seeding from CSV | `jobs/my_career_agent_jobs/seed_companies.py` | Done |
| Posting integrity check: hidden text removed before scoring, planted instructions flagged | `packages/core/src/postingGuard.ts` | Done, tested; runs in every adapter and in `/score` |
| ATS text-layer check of a resume PDF (dates, contact details, keywords) | `packages/core/src/atsText.ts`, `jobs/my_career_agent_jobs/ats_text.py` | Done, tested; wired up with resume rendering |
| Form-field answers: measured lengths, short variants, figures traced to verified facts | `packages/core/src/formFields.ts` | Done, tested |
| Language and eligibility gates (citizenship, permanent residency, clearance) | `packages/core/src/gates.ts` | Done, tested; in `/score`, ranking next |
| Follow-up policy: 10 quiet days, at most two, drafts only, no new claims | `packages/core/src/followups.ts` | Done, tested; cap also enforced in the database |

Several of these are adapted from [ai-job-search](https://github.com/ai-job-search-dev/ai-job-search) (MIT); see `THIRD_PARTY_NOTICES.md`.

## POC progress (see the delivery plan in the technical design doc)

Each loop is done only when its automated check, its real-use check and its exit condition pass.

| Loop | Code | Automated check | Real-use check (yours) |
| --- | --- | --- | --- |
| P0 Foundations | Token auth, migrations, CI, `scripts/smoke.mjs` | Passing: RLS, auth tests | Deploy, then `npm run smoke` |
| P1 Catalog | Adapters, ingestion, sponsor loader, integrity check | Passing: fixtures, diff | 3 days of clean ingestion; 20 jobs hand-checked |
| P2 Profile and scoring | `/profile`, `/facts`, `/languages`, `/work-auth`, `/targets`, `/companies`, `/score` | Passing: end-to-end on in-process Postgres | Hand-label 10 jobs; ranks agree on 8 or more |
| P3 Daily queue | `buildDailyQueue` (core), `apps/api/src/queue.ts`, daily cron, `/queue/build`, `/queue/runs/:date` | Passing: unit + end-to-end | Review 3 daily queues: 7 of 10 worth applying |
| P4 Referrals | `parseLinkedInExport`, `/connections/import`, `/referrals/:jobId`, drafted asks | Passing: parser + end-to-end | Import your export; 50 matches sampled, 90% right |
| P5 Apply packet and tracker | Answer bank, form-answer checks, `/packets/:jobId`, `/applications`, web app | Passing: end-to-end + browser walkthrough | 10 real applications, no wrong answers |

## Beta progress

| Loop | Code | Automated check |
| --- | --- | --- |
| B1 Accounts and onboarding | Email and password sign-up (invite-only), sessions, personal access tokens, setup wizard, data export and deletion: `apps/api/src/auth.ts`, `db/migrations/0005_accounts.sql` | Passing: accounts tests, RLS denial tests |
| B2 Resume files | Tailored PDF and Word files from confirmed facts only, with the text-layer check: `packages/core/src/resume.ts`, `apps/api/src/resumeFiles.ts` | Passing: the PDF's real text layer is read back |
| B3 Email and follow-ups | Forwarding addresses, stage updates from employer emails, follow-up and thank-you drafts: `apps/api/src/email.ts`, `followupsApi.ts` | Passing: classifier and end-to-end |
| B4 AI connector and own AI | MCP server at `/mcp` (10 tools, bearer tokens), bring-your-own Anthropic or OpenAI key: `apps/api/src/mcp.ts`, `ai.ts` | Passing: MCP protocol and stubbed provider |
| B5 Timing and pay | Offer window learned from your own stage history; pay benchmarks from H-1B wage data: `packages/core/src/timing.ts`, `jobs/my_career_agent_jobs/pay_lca.py` | Passing: TS and Python |
| B6 Billing and privacy | Stripe Checkout and Portal, webhook (off for the free beta); draft privacy notice and DPIA in `docs/privacy/` | Passing: signature and gating tests |
| B7 UK and Canada | Home Office sponsor register, ESDC LMIA list, country rules and currencies: `packages/core/src/countries.ts`, `jobs/my_career_agent_jobs/uk_ca_sponsors.py` | Passing: TS and Python |

## The web app

Open the Worker URL. Beta users sign up with an invite code. The POC account signs in with
**Sign in with an access token** using `MCA_TOKEN`, then adds an email and password in
Settings > Account.

Setup starts with the resume: drop a PDF, Word (.docx) or LaTeX (.tex) file and the app reads it
**in the browser** (the file is never uploaded) into roles, achievements, education, projects,
skills, certifications, languages and contact details. One review screen shows everything,
pre-filled, with any guesses marked **Check**; one save stores it as confirmed facts and fills the
answer bank, languages, home country and a first target role. Work authorization, target roles,
remaining answers and an optional LinkedIn import follow.

The reader (`packages/resume-import`) uses pdf.js (Mozilla) for PDFs, mammoth for Word and
unified-latex for LaTeX, then one deterministic structurer. It is measured on 12 fixture files
covering Jake's resume and moderncv (LaTeX source and PDF), awesome-cv source, one- and two-column
Word files and their PDF exports, a header-only Word layout and a European CV: every field matches.
Rebuild the fixtures with `npm run fixtures -w packages/resume-import`.

- **Today**: the offer-window strip, then the day's queue. Approve, skip, ask for referrals, open the packet.
- **Applications**: a transit map of live processes converging on the offer window. Offers expected
  early or late stop short of it. Below the map, a filterable, sortable table with notes and full history.
- **Packet**: tailored resume downloads with the readability check, copy-into-form fields,
  free-text answers (optionally drafted with your own AI key) and status.
- **Follow-ups**: drafts due now, plus your forwarding address and recent employer emails.
- **Network**, **Profile** and **Settings**: the answer bank, work authorization, companies,
  connectors, your AI key, plan and account. Account has **Start setup over**: tick what to clear
  (facts, answers, languages, work authorization, targets, companies, contacts, and optionally
  applications) and setup starts again; the login and tokens stay.

The visual design follows `apps/api/DESIGN.md` (built with Impeccable), and the UX strategy
follows `docs/ux/strategy.md` (built with Intent).

Try it without any accounts: run `npm run build:web` once, then `npx tsx scripts/dev-local.mts`, and open http://localhost:8788
and create an account (no invite needed locally). It runs the real app on an in-memory database
with eight demo companies.

## Not built yet

- OAuth for MCP, so claude.ai web connectors can connect. Bearer tokens work in desktop and CLI clients.
- Email forwarding needs a domain with Cloudflare Email Routing (see DEPLOY.md).
- Legal review of the privacy notice and terms; controller details.
- Netherlands and other EU country packs; entity resolution beyond exact normalised names.
- ESCO skills import (a small cross-occupation starter dictionary ships in `packages/core/src/skills.ts`).

## Cost

$0 while building (Workers Free, Neon Free, GitHub Actions in a public repo). About $6/month at launch:
Workers Paid $5, Neon pay-as-you-go, a domain.

## Setup

Requirements: Node 20+, Python 3.11+, a Cloudflare account, a Neon account (EU region).

```bash
npm install
npm test            # core, RLS and API tests
npm run typecheck
cd jobs && pip install -e ".[dev,db]" && pytest -q
```

### 1. Database (Neon)

1. Create a Neon project in an EU region.
2. Run the migrations in order as the project owner:
   `for f in db/migrations/*.sql; do psql "$NEON_OWNER_URL" -f "$f"; done`
3. Create two login roles and grant them the group roles the migration created:
   ```sql
   CREATE ROLE mca_api LOGIN PASSWORD '...';     GRANT mca_app TO mca_api;
   CREATE ROLE mca_loader LOGIN PASSWORD '...';  GRANT mca_ingest TO mca_loader;
   ```
   Never connect the API as the owner: row-level security relies on the API using `mca_app`.

### 2. Worker (Cloudflare)

```bash
cd apps/api
npx wrangler secret put DATABASE_URL          # connection string for mca_api
npx wrangler secret put INGEST_DATABASE_URL   # connection string for mca_loader
npx wrangler secret put API_TOKENS            # POC auth: "yourname:<random token>", see below
npx wrangler deploy
```

Make a token with `openssl rand -base64 32` (at least 24 characters). Then check the deploy:
`MCA_URL=https://<your worker> MCA_TOKEN=<token> npm run smoke`.

For local development create `apps/api/.dev.vars` with both URLs and `DEV_MODE=true`, then `npm run dev`.

### 3. Seed companies and sponsor data

```bash
cd jobs
python -m my_career_agent_jobs.seed_companies companies.example.csv --database-url "$INGEST_DATABASE_URL"
python -m my_career_agent_jobs.us_dol --lca LCA_FY2026_Q3.xlsx --perm PERM_FY2026_Q3.xlsx --database-url "$INGEST_DATABASE_URL"
```

Or run the **US sponsor data** GitHub Action with the current file URLs from the
[OFLC performance page](https://www.dol.gov/agencies/eta/foreign-labor/performance).

## Set up your profile and build a queue (POC)

```bash
H="authorization: Bearer $MCA_TOKEN"; U="$MCA_URL/api"
curl -s -X PUT  "$U/profile"      -H "$H" -d '{"homeCountry":"US","dailyTarget":10}'
curl -s -X POST "$U/facts"        -H "$H" -d '[{"kind":"role","text":"Data engineer at Hooli","skills":["python","sql","aws"],"startDate":"2018-01-01","verified":true}]'
curl -s -X PUT  "$U/languages"    -H "$H" -d '[{"language":"English","level":"C2"}]'
curl -s -X PUT  "$U/work-auth/US" -H "$H" -d '{"status":"needs_sponsorship","minLcaFilings":5,"minPermCertified":3}'
curl -s -X POST "$U/targets"      -H "$H" -d '{"country":"US","title":"Data Engineer","seniority":"senior"}'
curl -s -X POST "$U/queue/build"  -H "$H"
curl -s "$U/queue" -H "$H"
curl -s "$U/queue/runs/$(date -u +%F)" -H "$H"   # every excluded job and why
```

The daily cron (06:05 UTC) builds the same queue for every user with a target. Manual scoring:
`curl -s -X POST "$U/score" -H "$H" -d '{"title":"Senior Data Engineer","description":"...","country":"US"}'`.

## Guardrails built into the code

- Tenant data is only reachable inside a transaction that sets `app.user_id`; policies are forced on
  every tenant table, and CI proves it (`db/test/rls.test.ts`).
- Scoring only counts **verified** facts; gap suggestions never invent experience.
- Sensitive form answers come only from the user's answer bank.
- A missing job board throws instead of closing every job at that company.
- Applications move through an explicit state machine with an append-only event log.
- Job postings are untrusted input: hidden text is stripped before anything reads them, and
  instruction-shaped text is flagged to the user (advisory, never a silent drop).
- A follow-up draft may only restate what the employer already received; the database refuses a
  third follow-up.
