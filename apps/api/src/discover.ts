// Grows the catalog from the sponsor lists: for the biggest sponsoring employers not yet tracked,
// try likely board names on each public job-board system and add the ones that check out.
//
// A board counts only if it has open jobs and it is really that employer: where the system reports
// the board's company name (Greenhouse, Workable, SmartRecruiters) it must match; elsewhere only
// the employer's full name is tried as the board name, never a shortened guess. Workday isn't
// tried: it refuses automated requests from GitHub's servers. Every check is remembered, so a miss
// isn't retried for 90 days. Runs weekly on GitHub (jobs-runner discover), politely: one employer
// at a time per worker, four workers.

import { normalizeCompanyName } from "@my-career-agent/core";
import type { Env } from "./env.js";
import { appDb, type Sql } from "./lib/db.js";

const UA = { "user-agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)", accept: "application/json" };
type Vendor = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "recruitee";
interface Probe { jobs: number; name: string | null }

/** Words that make a name too generic to try alone as a board name. */
const GENERIC = new Set(["AMERICAN", "GLOBAL", "UNITED", "NATIONAL", "FIRST", "GENERAL", "INTERNATIONAL", "DATA", "TECH", "SOFTWARE", "SYSTEMS", "SOLUTIONS", "SERVICES", "HEALTH", "CAPITAL", "GROUP", "BANK", "UNIVERSITY", "COLLEGE", "STATE", "CITY", "NEW", "NORTH", "SOUTH", "EAST", "WEST"]);
const EXTRA_SUFFIX = new Set(["TECHNOLOGIES", "TECHNOLOGY", "HOLDINGS", "GROUP", "USA", "US", "AMERICA", "AMERICAS", "LABS", "INTERNATIONAL", "GLOBAL"]);

/** Board names to try, most likely first, each marked whether it's the full name (safe without a name check). */
export function slugsFor(employer: string): Array<{ slug: string; full: boolean }> {
  const words = normalizeCompanyName(employer).split(" ").filter(Boolean);
  const core = [...words];
  while (core.length > 1 && EXTRA_SUFFIX.has(core[core.length - 1]!)) core.pop();
  const out: Array<{ slug: string; full: boolean }> = [];
  const add = (w: string[], full: boolean) => {
    for (const s of [w.join(""), w.join("-")]) if (s.length >= 3 && !out.some((o) => o.slug === s.toLowerCase())) out.push({ slug: s.toLowerCase(), full });
  };
  add(words, true);
  if (core.length !== words.length) add(core, true);
  if (core.length > 1 && core[0]!.length >= 4 && !GENERIC.has(core[0]!)) add([core[0]!], false);
  return out.slice(0, 5);
}

/** Whether a board's own company name is this employer. */
export function sameCompany(boardName: string, employer: string): boolean {
  const a = normalizeCompanyName(boardName).replace(/ /g, ""), b = normalizeCompanyName(employer).replace(/ /g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.5;
}

export class SlowDown extends Error {}
async function getJson(url: string, f: typeof fetch): Promise<unknown | null> {
  const r = await f(url, { headers: UA });
  if (r.status === 404 || r.status === 410 || r.status === 400) return null;
  if (r.status === 429 || r.status === 503) throw new SlowDown(new URL(url).host);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function probe(vendor: Vendor, slug: string, f: typeof fetch = fetch): Promise<Probe | null> {
  const s = encodeURIComponent(slug);
  switch (vendor) {
    case "greenhouse": {
      const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${s}`, f);
      if (!isObj(meta)) return null;
      const jobs = await getJson(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, f);
      return { jobs: isObj(jobs) && Array.isArray(jobs.jobs) ? jobs.jobs.length : 0, name: typeof meta.name === "string" ? meta.name : null };
    }
    case "lever": {
      const b = await getJson(`https://api.lever.co/v0/postings/${s}?mode=json&limit=5`, f);
      return Array.isArray(b) ? { jobs: b.length, name: null } : null;
    }
    case "ashby": {
      const b = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${s}`, f);
      return isObj(b) && Array.isArray(b.jobs) ? { jobs: b.jobs.length, name: null } : null;
    }
    case "workable": {
      const b = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${s}`, f);
      return isObj(b) && Array.isArray(b.jobs) ? { jobs: b.jobs.length, name: typeof b.name === "string" ? b.name : null } : null;
    }
    case "smartrecruiters": {
      const b = await getJson(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`, f);
      const first = isObj(b) && Array.isArray(b.content) && isObj(b.content[0]) ? b.content[0] : null;
      const co = first && isObj(first.company) ? first.company : null;
      return isObj(b) && typeof b.totalFound === "number" ? { jobs: b.totalFound, name: co && typeof co.name === "string" ? co.name : null } : null;
    }
    case "recruitee": {
      if (!/^[a-z0-9-]+$/.test(slug)) return null;
      const b = await getJson(`https://${slug}.recruitee.com/api/offers/`, f);
      return isObj(b) && Array.isArray(b.offers) ? { jobs: b.offers.length, name: null } : null;
    }
  }
}

const ORDER: Vendor[] = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee"];
const NAMED = new Set<Vendor>(["greenhouse", "workable", "smartrecruiters"]);

export interface FindResult { hit: { vendor: Vendor; board: string; name: string; jobs: number } | null; tried: number; skipped: boolean }
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Finds one employer's board. A system that answers "slow down" is added to `resting` and skipped
 * for the rest of the run; an employer with a skipped system isn't a confirmed miss.
 */
export async function findBoard(employer: string, f: typeof fetch = fetch, resting = new Set<Vendor>(), gapMs = 0): Promise<FindResult> {
  let tried = 0, skipped = false;
  for (const { slug, full } of slugsFor(employer)) {
    for (const vendor of ORDER) {
      // Without a name to check, only the employer's full name is trusted as the board name.
      if (!full && !NAMED.has(vendor)) continue;
      if (resting.has(vendor)) { skipped = true; continue; }
      tried++;
      if (gapMs) await pause(gapMs);
      const p = await probe(vendor, slug, f).catch((e) => {
        if (e instanceof SlowDown) { resting.add(vendor); skipped = true; }
        return null;
      });
      if (!p || p.jobs < 1) continue;
      if (p.name !== null && !sameCompany(p.name, employer)) continue;
      if (p.name === null && !full) continue;
      return { hit: { vendor, board: slug, name: p.name ?? employer, jobs: p.jobs }, tried, skipped };
    }
  }
  return { hit: null, tried, skipped };
}

const pretty = (s: string) => normalizeCompanyName(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export interface DiscoverReport { checked: number; found: number; added: Array<{ name: string; vendor: string }>; stoppedEarly: boolean; resting: string[]; unfinished: number }

export async function discoverCompanies(env: Env, opts: { limit?: number; fetcher?: typeof fetch; gapMs?: number } = {}): Promise<DiscoverReport> {
  const sql: Sql = env.TEST_INGEST_SQL ?? appDb(env.INGEST_DATABASE_URL);
  const f = opts.fetcher ?? fetch;
  const candidates = (await sql`
    SELECT s.employer_norm, max(s.employer_name) AS employer_name, sum(s.filings)::int AS filings
    FROM mca.sponsor_record s
    WHERE s.company_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM mca.company c WHERE c.name_norm = s.employer_norm OR s.employer_norm = ANY (c.aliases))
      AND NOT EXISTS (SELECT 1 FROM mca.board_discovery d WHERE d.employer_norm = s.employer_norm AND d.checked_at > now() - interval '90 days')
    GROUP BY s.employer_norm
    ORDER BY sum(s.filings) DESC
    LIMIT ${opts.limit ?? 150}`) as Array<{ employer_norm: string; employer_name: string; filings: number }>;

  const report: DiscoverReport = { checked: 0, found: 0, added: [], stoppedEarly: false, resting: [], unfinished: 0 };
  const resting = new Set<Vendor>();
  let i = 0;
  const worker = async () => {
    while (i < candidates.length) {
      // Every system asked us to slow down: stop; the rest wait for next week.
      if (resting.size === ORDER.length) { report.stoppedEarly = true; return; }
      const c = candidates[i++]!;
      const { hit, skipped, tried } = await findBoard(c.employer_name, f, resting, opts.gapMs ?? 300);
      report.checked++;
      if (!hit && skipped) { report.unfinished++; continue; } // not every system was asked: not a miss
      if (!hit) {
        await sql`INSERT INTO mca.board_discovery (employer_norm, checked_at) VALUES (${c.employer_norm}, now())
                  ON CONFLICT (employer_norm) DO UPDATE SET checked_at = now(), found_vendor = NULL, found_board = NULL`;
        continue;
      }
      const name = hit.name === c.employer_name ? pretty(c.employer_name) : hit.name;
      const norm = normalizeCompanyName(name);
      // The sponsor list's spelling becomes an alias, so its records keep matching this company.
      const aliases = c.employer_norm !== norm ? [c.employer_norm] : [];
      const [row] = (await sql`
        INSERT INTO mca.company (name, name_norm, aliases, ats_vendor, ats_board, source)
        VALUES (${name}, ${norm}, ${aliases}::text[], ${hit.vendor}, ${hit.board}, 'discovered')
        ON CONFLICT (ats_vendor, ats_board) DO UPDATE SET aliases = ARRAY(SELECT DISTINCT unnest(mca.company.aliases || EXCLUDED.aliases))
        RETURNING id`) as Array<{ id: string }>;
      await sql.transaction([
        sql`UPDATE mca.sponsor_record SET company_id = ${row!.id}::uuid WHERE company_id IS NULL AND employer_norm = ${c.employer_norm}`,
        sql`INSERT INTO mca.board_discovery (employer_norm, checked_at, found_vendor, found_board, company_id, tried)
            VALUES (${c.employer_norm}, now(), ${hit.vendor}, ${hit.board}, ${row!.id}::uuid, ${tried})
            ON CONFLICT (employer_norm) DO UPDATE SET checked_at = now(), found_vendor = EXCLUDED.found_vendor, found_board = EXCLUDED.found_board,
              company_id = EXCLUDED.company_id, tried = EXCLUDED.tried`,
      ]);
      report.found++;
      report.added.push({ name, vendor: hit.vendor });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  report.resting = [...resting];
  return report;
}
