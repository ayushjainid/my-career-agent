// Fetches job boards and builds queues. Runs on GitHub Actions (.github/workflows/jobs.yml), not on
// the Worker: the Workers free plan allows 10 ms of CPU per request, and one large board takes ~850 ms.
//
//   node dist/jobs-runner.mjs fetch [--stale-minutes 60]   fetch boards not fetched in that long (0 = all)
//   node dist/jobs-runner.mjs queues [--user <id>]         build today's queue for one user, or everyone
//   node dist/jobs-runner.mjs discover [--limit 150]           add job boards for the biggest sponsors not yet tracked
//   node dist/jobs-runner.mjs catalog                      report: every company, its board, open jobs by country, and what can't be read
//   node dist/jobs-runner.mjs coverage [--gaps 60]         coverage KPI per country against the sponsor lists, plus the biggest gaps
//   node dist/jobs-runner.mjs detect [--limit 200]         find job boards through employers' own careers pages
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
import { detectCompanies } from "../apps/api/src/detect.js";
import { runFreehire } from "../apps/api/src/freehire.js";
import { appendFileSync, writeFileSync } from "node:fs";
import { fetchAny } from "../apps/api/src/ats/adapters.js";
import type { AtsVendor } from "@my-career-agent/core";

const [cmd, ...rest] = process.argv.slice(2);
// Node's HTTP client (undici) can throw an internal assertion from a socket event when a site
// closes a connection mid-response; that one request fails, not the whole run.
process.on("uncaughtException", (e) => {
  if (e instanceof Error && /ERR_ASSERTION|paused/.test(`${(e as { code?: string }).code ?? ""} ${e.message}`)) {
    console.log(`::warning::A connection failed inside the HTTP client: ${e.message.split("\n")[0]}`);
    return;
  }
  throw e;
});
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const env = { ...process.env } as unknown as Env;

async function fetchJobs() {
  const stale = Number(flag("stale-minutes") ?? 0);
  const r = await runIngest(env, { limit: 5000, staleAfterMinutes: stale });
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
  const r = await discoverCompanies(env, { limit: Number(flag("limit") ?? 150), country: flag("country") });
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

/**
 * Coverage KPI, per country. The denominator is the government sponsor list (US: LCA filings for
 * computer occupations, SOC 15-*); an employer counts as covered when a tracked company with that
 * name or alias has a working board with open jobs. Reports volume-weighted coverage (share of
 * filings), top-N coverage and plain head-count coverage, plus the biggest uncovered employers.
 */
const NON_TECH = "(^|[^A-Z0-9])(HOSPITALS?|HEALTH|HEALTHCARE|HSE|NHS|NURSING|NURSES?|CARE|CARERS|CLINICS?|MEDICAL|PHARMACY|PHARMACIES|DENTAL|DENTISTS?|SURGERY|DOCTORS?|VETERINARY|MEATS?|FOODS?|FARMS?|FARMING|RESTAURANTS?|HOTELS?|CATERING|TAKEAWAY|BAKERY|DAIRY|POULTRY|MUSHROOMS?|FISH|FISHERIES|BUTCHERS?|CONSTRUCTION|BUILDERS|SCHOOLS?|NURSERY|CLEANING|HOSPITALITY|INNS?|PUBS?|CAFE|KEBAB|PIZZA|CURRY|SUPERMARKET|CHURCH|HOMECARE|CHEMIST)([^A-Z0-9]|$)";

/**
 * Links sponsor records to tracked companies: by name or alias, or when the sponsor's name is the
 * company's name followed only by country or legal words ("STRIPE TECHNOLOGY COMPANY", "GOOGLE
 * IRELAND"). Discovered companies match by name and alias only.
 */
const ENTITY_WORDS = String.raw`(IRELAND|CANADA|UK|US|USA|AMERICA|AMERICAS|NORTH AMERICA|EUROPE|EMEA|INTERNATIONAL|GLOBAL|TECHNOLOGY|TECHNOLOGIES|TECH|SERVICES|SERVICE|SOLUTIONS|OPERATIONS|COMPANY|HOLDINGS|GROUP|LABS|RESEARCH|DEVELOPMENT|SOFTWARE|SYSTEMS|DIGITAL|CLOUD|PAYMENTS|FINANCIAL|ENTERPRISE|INNOVATION|CENTRE|CENTER|DATA|ITALIA|ITALY|BRITAIN|ENGLAND|LONDON|DUBLIN|TORONTO|VANCOUVER|MONTREAL|AND|OF|THE|N A|NA|SE|SRL|SPA|ULC|PLC|LP|LLP|UNLIMITED)`;
async function linkSponsors(sql: ReturnType<typeof appDb>) {
  // Records still pointing at a company that is no longer read (no board, or SmartRecruiters) are
  // freed first, so they can link to the company that is read now.
  const freed = (await sql`
    UPDATE mca.sponsor_record SET company_id = NULL
    WHERE company_id IN (SELECT id FROM mca.company WHERE (ats_board IS NULL AND source <> 'freehire') OR ats_vendor = 'smartrecruiters')
    RETURNING id`) as unknown[];
  if (freed.length) console.log(`Freed ${freed.length} sponsor records from companies that are no longer read.`);
  // Exact: name or alias (a hash join on the expanded names); curated companies before discovered ones.
  await sql`
    WITH names AS (SELECT id, name_norm AS n, source FROM mca.company WHERE ats_board IS NOT NULL OR source = 'freehire'
                   UNION SELECT id, unnest(aliases), source FROM mca.company WHERE ats_board IS NOT NULL),
         best AS (SELECT DISTINCT ON (n) n, id FROM names ORDER BY n, (source = 'freehire'), (source = 'discovered'))
    UPDATE mca.sponsor_record s SET company_id = best.id FROM best
    WHERE s.company_id IS NULL AND s.employer_norm = best.n`;
  const exact = (await sql`
    WITH names AS (SELECT id, name_norm AS n FROM mca.company UNION SELECT id, unnest(aliases) FROM mca.company)
    UPDATE mca.sponsor_record s SET company_id = names.id FROM names
    WHERE s.company_id IS NULL AND s.employer_norm = names.n
    RETURNING s.id`) as unknown[];
  // Prefix: the company's name followed only by country or legal words. Matched here, not in SQL,
  // because a pattern join across every sponsor row is far too slow.
  const words = new Set(ENTITY_WORDS.replace(/[()]/g, "").split("|"));
  const companies = (await sql`SELECT id, name_norm FROM mca.company WHERE source <> 'discovered' AND ats_board IS NOT NULL AND length(name_norm) >= 4`) as Array<{ id: string; name_norm: string }>;
  const byName = new Map(companies.filter((c) => /^[A-Z0-9 ]+$/.test(c.name_norm) && !words.has(c.name_norm)).map((c) => [c.name_norm, c.id]));
  const open = (await sql`SELECT DISTINCT employer_norm FROM mca.sponsor_record WHERE company_id IS NULL`) as Array<{ employer_norm: string }>;
  const plan = new Map<string, string[]>();
  for (const { employer_norm } of open) {
    const w = employer_norm.split(" ");
    for (let k = w.length - 1; k >= 1; k--) {
      const id = byName.get(w.slice(0, k).join(" "));
      if (!id) continue;
      // "N A" and "NORTH AMERICA" are two words each; check the tail word by word.
      if (w.slice(k).every((x) => words.has(x) || x === "N" || x === "A" || x === "NORTH")) (plan.get(id) ?? plan.set(id, []).get(id)!).push(employer_norm);
      break;
    }
  }
  let prefix = 0;
  for (const [id, norms] of plan) {
    const r = (await sql`UPDATE mca.sponsor_record SET company_id = ${id}::uuid WHERE company_id IS NULL AND employer_norm = ANY(${norms}::text[]) RETURNING id`) as unknown[];
    prefix += r.length;
  }
  console.log(`Linked ${exact.length} sponsor records by name or alias, ${prefix} by company name plus country or legal words.`);
}

async function coverage() {
  const sql = appDb(env.INGEST_DATABASE_URL);
  await linkSponsors(sql);
  const rows = (await sql`
    WITH emp AS (
      SELECT country, employer_norm, max(employer_name) AS name, sum(filings)::bigint AS filings
      FROM mca.sponsor_record
      WHERE (country = 'US' AND source = 'dol_lca' AND occupation_code LIKE '15-%')
         OR (country = 'CA' AND occupation_code LIKE '212%')
         -- Ireland and the UK publish no occupation per employer: leave out names that are plainly not tech hirers.
         OR (country IN ('IE', 'GB') AND employer_norm !~ ${NON_TECH})
         OR country NOT IN ('US', 'CA', 'IE', 'GB')
      GROUP BY 1, 2),
    -- A company counts for a country only when it has open jobs there.
    live AS (
      SELECT DISTINCT c.id, j.country FROM mca.company c JOIN mca.job j ON j.company_id = c.id
      WHERE (c.ats_board IS NOT NULL OR c.source = 'freehire') AND j.status = 'open' AND j.ats_vendor <> 'manual'),
    linked AS (SELECT DISTINCT s.country, s.employer_norm FROM mca.sponsor_record s JOIN live l ON l.id = s.company_id AND l.country = s.country),
    m AS (
      SELECT e.*, EXISTS (SELECT 1 FROM linked k WHERE k.employer_norm = e.employer_norm AND k.country = e.country) AS covered,
             row_number() OVER (PARTITION BY e.country ORDER BY e.filings DESC) AS rank
      FROM emp e)
    SELECT m.*, d.found_vendor, d.employer_norm IS NOT NULL AS checked FROM m
    LEFT JOIN mca.board_discovery d ON d.employer_norm = m.employer_norm`) as Array<{
      country: string; employer_norm: string; name: string; filings: string; covered: boolean; rank: string; checked: boolean }>;
  const by = new Map<string, typeof rows>();
  for (const r of rows) (by.get(r.country) ?? by.set(r.country, []).get(r.country)!).push(r);
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
  let md = "### Coverage KPI\n\n| Country | Filings covered | Change | Top 100 | Top 500 | Top 1000 | All employers |\n| --- | --- | --- | --- | --- | --- | --- |\n";
  for (const [country, list] of [...by].sort()) {
    const tot = list.reduce((n, r) => n + Number(r.filings), 0);
    const cov = list.filter((r) => r.covered);
    const top = (n: number) => { const t = list.filter((r) => Number(r.rank) <= n); return pct(t.filter((r) => r.covered).length, t.length); };
    // The UK register carries no size, so also measure the routes that point to tech and large employers.
    const route = async (pattern: string) => {
      if (country !== "GB") return undefined;
      const [r] = (await sql`
        WITH e AS (SELECT DISTINCT employer_norm FROM mca.sponsor_record WHERE country = 'GB' AND extra->>'route' ~* ${pattern})
        SELECT count(*)::int AS n, count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM mca.sponsor_record s JOIN mca.company c ON c.id = s.company_id
          WHERE s.employer_norm = e.employer_norm AND (c.ats_board IS NOT NULL OR c.source = 'freehire')
            AND EXISTS (SELECT 1 FROM mca.job j WHERE j.company_id = c.id AND j.status = 'open' AND j.country = 'GB')))::int AS covered FROM e`) as Array<{ n: number; covered: number }>;
      return r ? { employers: r.n, covered: r.covered, pct: pct(r.covered, r.n) } : undefined;
    };
    const metrics = {
      scaleUp: await route("scale-?up"), globalMobility: await route("global business mobility"),
      employers: list.length, covered: cov.length, filings: tot,
      filingsCovered: cov.reduce((n, r) => n + Number(r.filings), 0),
      volumePct: pct(cov.reduce((n, r) => n + Number(r.filings), 0), tot),
      top100Pct: top(100), top500Pct: top(500), top1000Pct: top(1000), headcountPct: pct(cov.length, list.length),
    };
    const [prev] = (await sql`SELECT metrics FROM mca.coverage_snapshot WHERE country = ${country} ORDER BY measured_at DESC LIMIT 1`) as Array<{ metrics: { volumePct?: number } }>;
    (metrics as Record<string, unknown>).change = prev?.metrics?.volumePct !== undefined ? Math.round((metrics.volumePct - prev.metrics.volumePct) * 10) / 10 : null;
    await sql`INSERT INTO mca.coverage_snapshot (country, metrics) VALUES (${country}, ${JSON.stringify(metrics)}::jsonb)`;
    console.log(`COVERAGE ${country} ${JSON.stringify(metrics)}`);
    if (metrics.scaleUp) md += `| GB Scale-up route | – | – | – | – | – | ${metrics.scaleUp.pct}% (${metrics.scaleUp.covered}/${metrics.scaleUp.employers}) |\n| GB Global Business Mobility | – | – | – | – | – | ${metrics.globalMobility?.pct}% (${metrics.globalMobility?.covered}/${metrics.globalMobility?.employers}) |\n`;
    md += `| ${country} | ${metrics.volumePct}% | ${(metrics as Record<string, unknown>).change ?? "–"} | ${metrics.top100Pct}% | ${metrics.top500Pct}% | ${metrics.top1000Pct}% | ${metrics.headcountPct}% (${cov.length}/${list.length}) |\n`;
    for (const r of list.filter((x) => !x.covered).sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, Number(flag("gaps") ?? 60)))
      console.log(`GAP ${country} ${JSON.stringify({ rank: Number(r.rank), name: r.name, norm: r.employer_norm, filings: Number(r.filings), checked: r.checked })}`);
  }
  // Italy has no sponsor register, so no coverage share: report what the catalog holds instead.
  const MILAN = "(^|[^a-z])(milan|milano)([^a-z]|$)";
  const [it] = (await sql`
    SELECT count(*)::int AS jobs, count(DISTINCT j.company_id)::int AS companies,
           count(*) FILTER (WHERE j.location_text ~* '\y(milan|milano)\y')::int AS milan_jobs,
           count(DISTINCT j.company_id) FILTER (WHERE j.location_text ~* '\y(milan|milano)\y')::int AS milan_companies
    FROM mca.job j WHERE j.status = 'open' AND j.country = 'IT'`) as Array<Record<string, number>>;
  const top = (await sql`
    SELECT c.name, count(*)::int AS jobs FROM mca.job j JOIN mca.company c ON c.id = j.company_id
    WHERE j.status = 'open' AND j.country = 'IT' AND j.location_text ~* '\y(milan|milano)\y'
    GROUP BY c.name ORDER BY count(*) DESC LIMIT 25`) as Array<{ name: string; jobs: number }>;
  const places = (await sql`SELECT location_text AS place, count(*)::int AS jobs FROM mca.job WHERE status = 'open' AND country = 'IT'
                             GROUP BY 1 ORDER BY 2 DESC LIMIT 15`) as Array<{ place: string; jobs: number }>;
  console.log(`ITALY ${JSON.stringify({ ...it, topMilan: top, places })}`);
  md += `\n**Italy** (no sponsor register, so no share): ${it?.jobs ?? 0} open jobs at ${it?.companies ?? 0} employers; Milan ${it?.milan_jobs ?? 0} jobs at ${it?.milan_companies ?? 0} employers.\n`;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, md);
}

/** Sponsor employer names matching a pattern, with filings: for curating company aliases. */
async function sponsors() {
  const sql = appDb(env.INGEST_DATABASE_URL);
  for (const pat of (flag("match") ?? "").split(",").filter(Boolean)) {
    const rows = (await sql`SELECT country, employer_norm, max(employer_name) AS name, sum(filings)::int AS filings FROM mca.sponsor_record
      WHERE employer_norm ~ ${pat} GROUP BY 1, 2 ORDER BY filings DESC LIMIT 25`) as Array<Record<string, unknown>>;
    for (const r of rows) console.log(`SPONSOR ${pat} ${JSON.stringify(r)}`);
  }
}

async function detectSites() {
  const r = await detectCompanies(env, { limit: Number(flag("limit") ?? 200), country: flag("country") });
  console.log(`Career sites: checked ${r.checked} employers, added ${r.added.length} boards; ${r.workdayOnly} link only to Workday; ${r.noSite} had no website found.`);
  for (const a of r.added) console.log(`ADDED ${JSON.stringify(a)}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && r.added.length)
    appendFileSync(summary, `### Boards found on career sites\n\n| Company | System | Board |\n| --- | --- | --- |\n${r.added.map((a) => `| ${a.name} | ${a.vendor} | ${a.board} |`).join("\n")}\n`);
}

async function freehire() {
  const r = await runFreehire(env, { days: Number(flag("days") ?? 3) });
  console.log(`freehire: ${r.requests} requests, ${r.seen} jobs seen, ${r.stored} stored, ${r.newCompanies} new employers, ${r.fromLinkedIn} of them listed from LinkedIn; skipped ${r.skippedDirect} already read directly; closed ${r.closed} not seen for 21 days.${r.stoppedEarly ? ` Stopped early: ${r.stoppedEarly}.` : ""}`);
}

if (cmd === "fetch") await fetchJobs();
else if (cmd === "catalog") await catalog();
else if (cmd === "coverage") await coverage();
else if (cmd === "sponsors") await sponsors();
else if (cmd === "detect") await detectSites();
else if (cmd === "freehire") await freehire();
else if (cmd === "discover") await discover();
else if (cmd === "gmail") await gmail();
else if (cmd === "queues") await queues();
else {
  console.error("usage: jobs-runner.mjs fetch [--stale-minutes N] | queues [--user ID] | gmail | discover [--limit N] | catalog | coverage [--gaps N]");
  process.exitCode = 2;
}
