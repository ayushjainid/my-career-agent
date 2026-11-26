// Fetches job boards and builds queues. Runs on GitHub Actions (.github/workflows/jobs.yml), not on
// the Worker: the Workers free plan allows 10 ms of CPU per request, and one large board takes ~850 ms.
//
//   node dist/jobs-runner.mjs fetch [--stale-minutes 60]   fetch boards not fetched in that long (0 = all)
//   node dist/jobs-runner.mjs queues [--user <id>]         build today's queue for one user, or everyone
//   node dist/jobs-runner.mjs discover [--limit 150]           add job boards for the biggest sponsors not yet tracked
//   node dist/jobs-runner.mjs catalog                      report: every company, its board, open jobs by country, and what can't be read
//   node dist/jobs-runner.mjs gmail                        read new job emails for everyone who linked Gmail
//
// Needs INGEST_DATABASE_URL (catalog role) and DATABASE_URL (app role, row-level security), which
// scripts/db-urls.mjs derives from DATABASE_OWNER_URL.
import type { Env } from "../apps/api/src/env.js";
import { runIngest } from "../apps/api/src/ingest.js";
import { appDb } from "../apps/api/src/lib/db.js";
import { neonTenantDb } from "../apps/api/src/lib/tenant.js";
import { runAllQueues } from "../apps/api/src/queue.js";
import { syncGmail } from "../apps/api/src/gmail.js";
import { discoverCompanies } from "../apps/api/src/discover.js";
import { appendFileSync, writeFileSync } from "node:fs";
import { fetchAny } from "../apps/api/src/ats/adapters.js";
import type { AtsVendor } from "@my-career-agent/core";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const env = { ...process.env } as unknown as Env;

async function fetchJobs() {
  const stale = Number(flag("stale-minutes") ?? 0);
  const r = await runIngest(env, { limit: 1000, staleAfterMinutes: stale });
  console.log(`Fetched ${r.boards} of ${r.total} job boards: ${r.added} new, ${r.updated} updated, ${r.closed} closed, ${r.stale} stale.`);
  for (const e of r.errors) console.log(`::warning::${e.board}: ${e.error}`);
}

async function queues() {
  const sql = appDb(env.DATABASE_URL);
  const one = flag("user");
  const users = one ? [one] : ((await sql`SELECT mca.users_for_queue() AS user_id`) as Array<{ user_id: string }>).map((u) => u.user_id);
  const results = await runAllQueues(env, neonTenantDb(sql), users);
  // Counts only: user ids stay out of the log.
  const failed = results.filter((r) => r.error);
  console.log(`Built ${results.length - failed.length} of ${results.length} queues; ${results.reduce((n, r) => n + r.queued, 0)} jobs queued in all.`);
  for (const f of failed) console.log(`::warning::A queue failed: ${f.error}`);
  if (failed.length && failed.length === results.length) process.exitCode = 1;
}

async function gmail() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.AI_KEY_SECRET) {
    console.log("Gmail isn't configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AI_KEY_SECRET); skipping.");
    return;
  }
  const sql = appDb(env.DATABASE_URL);
  const users = ((await sql`SELECT mca.gmail_users() AS user_id`) as Array<{ user_id: string }>).map((u) => u.user_id);
  const db = neonTenantDb(sql);
  let stored = 0, moved = 0, failed = 0;
  for (const u of users) {
    const r = await syncGmail(env, db, u);
    stored += r.stored; moved += r.moved;
    if (r.error) { failed++; console.log(`::warning::A Gmail sync failed: ${r.error}`); }
  }
  // Counts only: no addresses, subjects or user ids in the log.
  console.log(`Gmail: ${users.length} linked, ${stored} job emails recorded, ${moved} applications moved, ${failed} failed.`);
}

async function discover() {
  const r = await discoverCompanies(env, { limit: Number(flag("limit") ?? 150) });
  console.log(`Discovery: checked ${r.checked} sponsoring employers, added ${r.found} job boards, ${r.unfinished} to finish next run.` +
    (r.resting.length ? ` Paused after asking us to slow down: ${r.resting.join(", ")}.` : "") + (r.stoppedEarly ? " Stopped early." : ""));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && r.added.length)
    appendFileSync(summary, `### Companies added\n\n| Company | Job board |\n| --- | --- |\n${r.added.map((a) => `| ${a.name} | ${a.vendor} |`).join("\n")}\n`);
}

/** Read-only report on the public catalog (no personal data): what can and can't be pulled. */
async function catalog() {
  const sql = appDb(env.INGEST_DATABASE_URL);
  const cos = (await sql`
    SELECT c.name, c.ats_vendor, c.ats_board, c.source, c.last_fetched_at,
           count(j.id) FILTER (WHERE j.status = 'open')::int AS open,
           count(j.id) FILTER (WHERE j.status = 'open' AND j.country = 'US')::int AS us,
           count(j.id) FILTER (WHERE j.status = 'open' AND j.country = 'GB')::int AS gb,
           count(j.id) FILTER (WHERE j.status = 'open' AND j.country = 'CA')::int AS ca,
           count(j.id) FILTER (WHERE j.status = 'open' AND j.country = 'IE')::int AS ie,
           count(j.id) FILTER (WHERE j.status = 'open' AND j.country = 'IT')::int AS it,
           count(j.id) FILTER (WHERE j.status = 'open' AND (j.country IS NULL OR j.country NOT IN ('US','GB','CA','IE','IT')))::int AS other
    FROM mca.company c LEFT JOIN mca.job j ON j.company_id = c.id AND j.ats_vendor <> 'manual'
    WHERE c.ats_board IS NOT NULL
    GROUP BY c.id ORDER BY open DESC, c.name`) as Array<Record<string, unknown>>;
  // Why a board shows nothing: ask it once more and keep the answer.
  for (const c of cos.filter((x) => x.open === 0)) {
    try {
      const r = await fetchAny({ vendor: c.ats_vendor as AtsVendor, board: String(c.ats_board) }, { maxPages: 1, maxDetails: 1 });
      c.why = r.jobs.length || r.touch.length ? "has jobs now (not yet fetched)" : "board is reachable but lists no open jobs";
    } catch (e) { c.why = (e as Error).message; }
  }
  const sponsors = (await sql`
    WITH emp AS (
      SELECT s.country, s.employer_norm, max(s.employer_name) AS name, sum(s.filings)::int AS filings, bool_or(s.company_id IS NOT NULL) AS tracked
      FROM mca.sponsor_record s GROUP BY s.country, s.employer_norm)
    SELECT e.country, e.name, e.filings, e.tracked,
           CASE WHEN e.tracked THEN 'tracked' WHEN d.employer_norm IS NULL THEN 'not checked yet'
                WHEN d.found_vendor IS NULL THEN 'checked: no readable board' ELSE 'found' END AS status,
           row_number() OVER (PARTITION BY e.country ORDER BY e.filings DESC) AS rank
    FROM emp e LEFT JOIN mca.board_discovery d ON d.employer_norm = e.employer_norm`) as Array<Record<string, unknown>>;
  const totals = (await sql`
    SELECT s.country, count(DISTINCT s.employer_norm)::int AS employers,
           count(DISTINCT s.employer_norm) FILTER (WHERE s.company_id IS NOT NULL)::int AS tracked
    FROM mca.sponsor_record s GROUP BY s.country ORDER BY s.country`) as Array<Record<string, unknown>>;
  const out = { companies: cos, sponsorsTop: sponsors.filter((s) => Number(s.rank) <= 25), totals,
    checked: (await sql`SELECT count(*)::int AS n, count(found_vendor)::int AS found FROM mca.board_discovery`) };
  writeFileSync("catalog-report.json", JSON.stringify(out, null, 1));
  // One line per record, so the report can be read straight from the run log.
  for (const c of cos) console.log(`REPORT company ${JSON.stringify(c)}`);
  for (const r of out.sponsorsTop) console.log(`REPORT sponsor ${JSON.stringify(r)}`);
  for (const t of totals) console.log(`REPORT total ${JSON.stringify(t)}`);
  console.log(`REPORT checked ${JSON.stringify(out.checked)}`);
  console.log(`Catalog: ${cos.length} companies with a job board, ${cos.filter((c) => Number(c.open) > 0).length} with open jobs.`);
}

if (cmd === "fetch") await fetchJobs();
else if (cmd === "catalog") await catalog();
else if (cmd === "discover") await discover();
else if (cmd === "gmail") await gmail();
else if (cmd === "queues") await queues();
else {
  console.error("usage: jobs-runner.mjs fetch [--stale-minutes N] | queues [--user ID] | gmail | discover [--limit N] | catalog");
  process.exitCode = 2;
}
