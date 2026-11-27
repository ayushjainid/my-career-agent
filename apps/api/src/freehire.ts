// freehire.me: an open-source tech-job aggregator with a public, unauthenticated JSON API that its
// robots.txt invites bots to use instead of the HTML (https://freehire.me/docs/api). It fills the
// employers this app can't read itself (Workday tenants, bot-protected career sites).
//
// Each run reads tech categories in the five countries for recently posted jobs, files each job
// under its own employer (created when new, source 'freehire'), and skips:
//   - jobs freehire took from LinkedIn (this app doesn't automate on or collect from LinkedIn);
//   - jobs from boards this app already reads directly (same employer, same system).
// A freehire job not seen again for 21 days is closed.

import { normalizeCompanyName, parsePayFromText, type NormalizedJob, type RemoteType } from "@my-career-agent/core";
import type { Env } from "./env.js";
import { appDb, type Sql } from "./lib/db.js";
import { guardedDescription } from "./lib/html.js";
import { toRecord } from "./ingest.js";

export const FREEHIRE_API = "https://freehire.me";
const UA = { "user-agent": "my-career-agent/job-sync/0.1 (+https://github.com/ayushjainid/my-career-agent)", accept: "application/json" };
export const FREEHIRE_COUNTRIES = ["us", "gb", "ie", "ca", "it"];
export const FREEHIRE_CATEGORIES = ["software_engineering", "backend", "frontend", "fullstack", "mobile", "devops", "sre", "ml_ai", "ai_engineering",
  "data_engineering", "data_science", "data_analytics", "qa", "security", "embedded", "system_administration", "network_engineering", "solutions_engineering",
  "architecture", "product", "developer_relations", "technical_writing", "it_support", "hardware"];
/** Systems this app reads itself: their jobs come straight from the source instead. */
const DIRECT = new Set(["greenhouse", "lever", "ashby", "workable", "recruitee", "amazon", "eightfold", "oracle", "teamtailor", "personio", "bamboohr", "rippling", "breezy", "avature"]);
const SKIP_SOURCES = /linkedin/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const sleep = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const PLACE: Record<string, string> = { us: "United States", gb: "United Kingdom", ie: "Ireland", ca: "Canada", it: "Italy" };

export interface FreehireJob { job: NormalizedJob; company: string; source: string; country: string | null }

export function parseFreehire(j: unknown): FreehireJob | null {
  if (!isObj(j)) return null;
  const slug = str(j.public_slug), title = str(j.title), company = str(j.company);
  if (!slug || !title || !company || str(j.closed_at)) return null;
  const countries = Array.isArray(j.countries) ? j.countries.filter((c): c is string => typeof c === "string") : [];
  const country = countries.find((c) => PLACE[c]) ?? null;
  // Name the country in the place text, so country detection downstream agrees with freehire's.
  const loc = str(j.location);
  const locationText = country ? (loc && !new RegExp(PLACE[country]!, "i").test(loc) ? `${loc}, ${PLACE[country]}` : loc ?? PLACE[country]!) : loc;
  const { text, integrity } = guardedDescription([{ html: str(j.description) }]);
  const mode = str((j.enrichment as Obj | undefined)?.work_mode) ?? str(j.work_mode);
  const remote: RemoteType = mode === "remote" || mode === "hybrid" || mode === "onsite" ? mode : /\bremote\b/i.test(loc ?? "") ? "remote" : "unknown";
  return {
    company,
    source: str(j.source) ?? "",
    country: country ? country.toUpperCase() : null,
    job: { atsVendor: "freehire", atsJobId: slug, title, locationText, remoteType: remote, pay: parsePayFromText(text),
      postedAt: str(j.posted_at), applyUrl: str(j.url) ?? `${FREEHIRE_API}/jobs/${slug}`, descriptionText: text, integrity },
  };
}

export interface FreehireReport { requests: number; seen: number; stored: number; skippedLinkedIn: number; skippedDirect: number; newCompanies: number; closed: number; stoppedEarly: string | null }

export async function runFreehire(env: Env, opts: { days?: number; fetcher?: typeof fetch; gapMs?: number; countries?: string[]; categories?: string[]; maxPages?: number } = {}): Promise<FreehireReport> {
  const sql: Sql = env.TEST_INGEST_SQL ?? appDb(env.INGEST_DATABASE_URL);
  const f = opts.fetcher ?? fetch;
  const gap = opts.gapMs ?? 1000;
  const base = (env as unknown as { FREEHIRE_API_URL?: string }).FREEHIRE_API_URL ?? FREEHIRE_API;
  const report: FreehireReport = { requests: 0, seen: 0, stored: 0, skippedLinkedIn: 0, skippedDirect: 0, newCompanies: 0, closed: 0, stoppedEarly: null };

  // Employers already read directly, by normalised name and alias.
  const tracked = (await sql`SELECT name_norm, aliases, ats_vendor FROM mca.company WHERE ats_board IS NOT NULL`) as Array<{ name_norm: string; aliases: string[]; ats_vendor: string }>;
  const direct = new Set<string>();
  for (const t of tracked) if (DIRECT.has(t.ats_vendor) || t.ats_vendor === "sitemap") for (const n of [t.name_norm, ...t.aliases]) direct.add(n);
  const companyIds = new Map<string, string>();

  outer: for (const country of opts.countries ?? FREEHIRE_COUNTRIES) {
    for (const category of opts.categories ?? FREEHIRE_CATEGORIES) {
      for (let page = 0, offset = 0; page < (opts.maxPages ?? 100) && offset < 10_000; page++) {
        const url = `${base}/api/v1/agent/jobs/search?countries=${country}&category=${category}&posted_within_days=${opts.days ?? 3}&limit=100&offset=${offset}&description_format=html`;
        let body: unknown;
        try {
          const r = await f(url, { headers: UA });
          report.requests++;
          if (!r.ok) {
            await r.body?.cancel().catch(() => {});
            // A 429 is a request to slow down: stop the run and pick up next time.
            if (r.status === 429 || r.status === 503) { report.stoppedEarly = `HTTP ${r.status} at ${country}/${category}`; break outer; }
            break;
          }
          body = await r.json();
        } catch (e) { report.stoppedEarly = `${country}/${category}: ${(e as Error).message}`; break; }
        const list = isObj(body) && Array.isArray(body.data) ? body.data : [];
        const parsed = list.map(parseFreehire).filter((x): x is FreehireJob => x !== null);
        report.seen += list.length;
        const keep: FreehireJob[] = [];
        for (const p of parsed) {
          if (SKIP_SOURCES.test(p.source)) { report.skippedLinkedIn++; continue; }
          const norm = normalizeCompanyName(p.company);
          if (!norm) continue;
          if (direct.has(norm) && DIRECT.has(p.source.toLowerCase())) { report.skippedDirect++; continue; }
          keep.push(p);
        }
        // One company row per employer: reuse a tracked one when the name matches.
        const names = [...new Set(keep.map((p) => normalizeCompanyName(p.company)))].filter((n) => !companyIds.has(n));
        if (names.length) {
          const found = (await sql`SELECT DISTINCT ON (name_norm) id, name_norm FROM mca.company WHERE name_norm = ANY(${names}::text[])
                                   ORDER BY name_norm, (ats_board IS NULL), (source = 'freehire')`) as Array<{ id: string; name_norm: string }>;
          for (const r of found) companyIds.set(r.name_norm, r.id);
          for (const n of names.filter((x) => !companyIds.has(x))) {
            const display = keep.find((p) => normalizeCompanyName(p.company) === n)!.company.slice(0, 200);
            const [row] = (await sql`INSERT INTO mca.company (name, name_norm, source) VALUES (${display}, ${n}, 'freehire') RETURNING id`) as Array<{ id: string }>;
            companyIds.set(n, row!.id);
            report.newCompanies++;
          }
        }
        const byCompany = new Map<string, ReturnType<typeof toRecord>[]>();
        for (const p of keep) {
          const id = companyIds.get(normalizeCompanyName(p.company))!;
          const rec = { ...toRecord(p.job), country: p.country ?? toRecord(p.job).country };
          (byCompany.get(id) ?? byCompany.set(id, []).get(id)!).push(rec);
        }
        for (const [id, rows] of byCompany) {
          await sql`
            INSERT INTO mca.job (company_id, ats_vendor, ats_job_id, title, location_text, country, remote_type,
              pay_min, pay_max, pay_currency, pay_period, pay_source, posted_at, apply_url,
              description_text, requirements, sponsorship_text_signal, integrity, status, last_seen_at)
            SELECT ${id}::uuid, r.ats_vendor, r.ats_job_id, r.title, r.location_text, r.country, r.remote_type,
              r.pay_min, r.pay_max, r.pay_currency, r.pay_period, r.pay_source, r.posted_at, r.apply_url,
              r.description_text, r.requirements, r.sponsorship_text_signal, r.integrity, 'open', now()
            FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
              ats_vendor text, ats_job_id text, title text, location_text text, country text, remote_type text,
              pay_min numeric, pay_max numeric, pay_currency text, pay_period text, pay_source text,
              posted_at timestamptz, apply_url text, description_text text, requirements jsonb,
              sponsorship_text_signal text, integrity jsonb)
            ON CONFLICT (ats_vendor, company_id, ats_job_id) DO UPDATE SET
              title = EXCLUDED.title, location_text = EXCLUDED.location_text, country = EXCLUDED.country,
              description_text = EXCLUDED.description_text, requirements = EXCLUDED.requirements,
              status = CASE WHEN mca.job.status = 'stale' THEN 'stale' ELSE 'open' END, last_seen_at = now()`;
          report.stored += rows.length;
        }
        offset += list.length;
        await sleep(gap);
        if (list.length < 100) break;
      }
    }
  }
  const closed = (await sql`UPDATE mca.job SET status = 'closed' WHERE ats_vendor = 'freehire' AND status = 'open' AND last_seen_at < now() - interval '21 days' RETURNING id`) as unknown[];
  report.closed = closed.length;
  return report;
}
