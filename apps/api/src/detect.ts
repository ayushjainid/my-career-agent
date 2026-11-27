// Career-site detector: for big sponsoring employers that slug-guessing (discover.ts) can't find,
// find the company's website from its name (a homepage whose title names the company; Wikidata's
// search API and query service close themselves to bots in robots.txt, so they aren't used), open
// its careers pages (robots.txt first),
// and recognise the job system they link to, or a job sitemap with JobPosting data. A candidate is
// added only after the board answers with open jobs. Every check is remembered for 90 days.

import { normalizeCompanyName } from "@my-career-agent/core";
import type { Env } from "./env.js";
import { appDb, type Sql } from "./lib/db.js";
import { politeFetch } from "./lib/robots.js";
import { fetchAny } from "./ats/adapters.js";
import { jobPostingsIn, microdataPosting } from "./ats/feeds.js";
import type { AtsVendor } from "@my-career-agent/core";

const UA = { "user-agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)" };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export interface Candidate { vendor: AtsVendor; board: string; via: string }

/** Job-system links in a careers page, as boards this app can read. */
export function boardsInPage(html: string): Candidate[] {
  const out: Candidate[] = [];
  const add = (vendor: AtsVendor, board: string, via: string) => { if (!out.some((c) => c.vendor === vendor && c.board.toLowerCase() === board.toLowerCase())) out.push({ vendor, board, via }); };
  const h = html.replace(/\\u002F/g, "/").replace(/&amp;/g, "&");
  for (const m of h.matchAll(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/gi)) if (!/^(embed|v1)$/i.test(m[1]!)) add("greenhouse", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi)) add("greenhouse", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/gi)) add("lever", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/g)) add("ashby", m[1]!, m[0]);
  for (const m of h.matchAll(/apply\.workable\.com\/([a-z0-9_-]+)/gi)) if (!/^api$/i.test(m[1]!)) add("workable", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+)\.recruitee\.com/gi)) add("recruitee", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+)\.teamtailor\.com/gi)) if (!/^(www|app|career|api)$/i.test(m[1]!)) add("teamtailor", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/gi)) add("personio", m[0].replace(/^https?:\/\//, "").toLowerCase(), m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/gi)) add("bamboohr", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+)\.breezy\.hr/gi)) if (!/^(app|www)$/i.test(m[1]!)) add("breezy", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/ats\.rippling\.com\/([a-z0-9_-]+)\/jobs/gi)) add("rippling", m[1]!.toLowerCase(), m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g)) if (!/^(wday|en-US)$/.test(m[2]!)) add("workday", `${m[1]}/${m[2]}`, m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([A-Za-z0-9_-]+)/g)) add("oracle", `${m[1]}|${m[2]}`, m[0]);
  for (const m of h.matchAll(/([a-z0-9-]+\.eightfold\.ai)\/careers\?[^"' ]*domain=([a-z0-9.-]+)/gi)) add("eightfold", `${m[1]!.toLowerCase()}|${m[2]!.toLowerCase()}`, m[0]);
  return out;
}

const careerPages = (site: string) => {
  const u = new URL(site);
  const host = u.hostname.replace(/^www\./, "");
  return [`https://${u.hostname}/careers`, `https://careers.${host}/`, `https://jobs.${host}/`, `https://${u.hostname}/jobs`, `https://${u.hostname}/en/careers`, `https://${u.hostname}/careers/jobs`];
};

const LEGAL = new Set(["US", "USA", "AMERICA", "AMERICAS", "NORTH", "SERVICES", "SERVICE", "SOLUTIONS", "TECHNOLOGIES", "TECHNOLOGY", "HOLDINGS", "GROUP", "INTERNATIONAL", "GLOBAL", "CONSULTING", "SYSTEMS", "COMPANY", "IRELAND", "CANADA", "UK", "NA", "N", "A", "THE", "AND", "OF"]);

/** The company's website, guessed from its name and confirmed by the homepage's title. */
export async function guessSite(name: string, f: typeof fetch): Promise<string | null> {
  const words = normalizeCompanyName(name).toLowerCase().split(" ").filter(Boolean);
  const core = words.filter((w) => !LEGAL.has(w.toUpperCase()));
  if (!core.length || core[0]!.length < 3) return null;
  const guesses = [...new Set([core.join(""), core[0]!, core.join("-"), words.join("")])].filter((g) => g.length >= 3).map((g) => `https://www.${g}.com/`);
  for (const url of guesses) {
    let r: Response;
    try { r = await f(url, { headers: { ...UA, accept: "text/html" }, redirect: "follow" }); } catch { continue; }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); continue; }
    const html = (await r.text().catch(() => "")).slice(0, 200_000);
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") + " " + (/property=["']og:site_name["'][^>]*content=["']([^"']+)/i.exec(html)?.[1] ?? "");
    // The homepage must name the company: its first two distinctive words, not just the first
    // ("Redwood Extended Care" is not Redwood Software).
    const need = core.slice(0, 2).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
    if (need.every((w) => new RegExp(`\\b${w}`, "i").test(title))) return r.url || url;
  }
  return null;
}

/** Career pages and sitemaps for one employer, most specific first. */
export async function detect(name: string, f: typeof fetch, gapMs = 400): Promise<{ site: string | null; found: Candidate[]; pages: number }> {
  const site = await guessSite(name, f).catch(() => null);
  if (!site || !/^https?:\/\//.test(site)) return { site, found: [], pages: 0 };
  const found: Candidate[] = [];
  let pages = 0;
  for (const url of careerPages(site)) {
    await sleep(gapMs);
    let r: Response;
    try { r = await f(url, { headers: { ...UA, accept: "text/html" }, redirect: "follow" }); } catch { continue; }
    pages++;
    if (!r.ok) { await r.body?.cancel().catch(() => {}); continue; }
    const html = await r.text().catch(() => "");
    for (const c of boardsInPage(html)) if (!found.some((x) => x.vendor === c.vendor && x.board === c.board)) found.push(c);
    // The careers host itself may publish a job sitemap with JobPosting pages.
    const origin = new URL(r.url || url).origin;
    if (/careers\.|jobs\./.test(origin) && !found.some((c) => c.vendor === "sitemap")) {
      await sleep(gapMs);
      try {
        const sm = await f(`${origin}/sitemap.xml`, { headers: UA });
        if (sm.ok) {
          const xml = await sm.text();
          const job = [...xml.matchAll(/<loc>\s*([^<\s]+\/jobs?\/[^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!)[0];
          if (job) {
            await sleep(gapMs);
            const page = await f(job, { headers: { ...UA, accept: "text/html" } });
            const ph = page.ok ? await page.text() : (await page.body?.cancel().catch(() => {}), "");
            if (jobPostingsIn(ph).length || microdataPosting(ph)) found.push({ vendor: "sitemap", board: `${origin}/sitemap.xml|/job`, via: job });
          } else if (/<sitemapindex/i.test(xml)) {
            found.push({ vendor: "sitemap", board: `${origin}/sitemap.xml|/job`, via: "sitemap index" });
          }
        } else await sm.body?.cancel().catch(() => {});
      } catch { /* no sitemap */ }
    }
    if (found.some((c) => c.vendor !== "workday")) break;
  }
  return { site, found, pages };
}

export interface DetectReport { checked: number; added: Array<{ name: string; vendor: string; board: string }>; workdayOnly: number; noSite: number }

export async function detectCompanies(env: Env, opts: { limit?: number; fetcher?: typeof fetch; gapMs?: number; country?: string } = {}): Promise<DetectReport> {
  const sql: Sql = env.TEST_INGEST_SQL ?? appDb(env.INGEST_DATABASE_URL);
  const f = opts.fetcher ?? politeFetch(fetch);
  // Biggest tech sponsors not yet covered by any tracked company and not checked in 90 days.
  const rows = (await sql`
    SELECT s.employer_norm, max(s.employer_name) AS employer_name, sum(s.filings)::int AS filings
    FROM mca.sponsor_record s
    WHERE ((s.country = 'US' AND s.occupation_code LIKE '15-%') OR (s.country = 'CA' AND s.occupation_code LIKE '212%') OR s.country = 'IE'
           OR (s.country = 'GB' AND s.extra->>'route' ~* 'scale-?up|global business mobility'))
      AND (${opts.country ?? null}::text IS NULL OR s.country = ${opts.country ?? null})
      AND NOT EXISTS (SELECT 1 FROM mca.company c WHERE c.id = s.company_id AND c.ats_board IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM mca.career_site_check k WHERE k.employer_norm = s.employer_norm AND k.checked_at > now() - interval '90 days')
    GROUP BY s.employer_norm ORDER BY sum(s.filings) DESC LIMIT ${opts.limit ?? 200}`) as Array<{ employer_norm: string; employer_name: string; filings: number }>;
  const report: DetectReport = { checked: 0, added: [], workdayOnly: 0, noSite: 0 };
  for (const row of rows) {
    const d = await detect(row.employer_name, f, opts.gapMs ?? 400).catch(() => ({ site: null, found: [] as Candidate[], pages: 0 }));
    report.checked++;
    if (!d.site) report.noSite++;
    let hit: Candidate | null = null;
    for (const c of d.found.filter((x) => x.vendor !== "workday")) {
      try {
        const r = await fetchAny({ vendor: c.vendor, board: c.board }, { fetcher: f, maxPages: 2, maxDetails: 2 });
        if (r.jobs.length + r.touch.length + (r.listed ?? 0) > 0) { hit = c; break; }
      } catch { /* not readable */ }
    }
    if (!hit && d.found.some((x) => x.vendor === "workday")) report.workdayOnly++;
    if (hit) {
      const name = row.employer_name.replace(/\s*,?\s*(inc\.?|llc|l\.l\.c\.|corp\.?|corporation|limited|ltd\.?|co\.)\s*$/i, "").trim();
      const [c] = (await sql`
        INSERT INTO mca.company (name, name_norm, aliases, domain, ats_vendor, ats_board, source)
        VALUES (${name}, ${normalizeCompanyName(name)}, ${[row.employer_norm]}::text[], ${d.site ? new URL(d.site).hostname.replace(/^www\./, "") : null}, ${hit.vendor}, ${hit.board}, 'discovered')
        ON CONFLICT (ats_vendor, ats_board) DO UPDATE SET aliases = ARRAY(SELECT DISTINCT unnest(mca.company.aliases || EXCLUDED.aliases))
        RETURNING id`) as Array<{ id: string }>;
      await sql`UPDATE mca.sponsor_record SET company_id = ${c!.id}::uuid WHERE employer_norm = ${row.employer_norm} AND company_id IS NULL`;
      report.added.push({ name, vendor: hit.vendor, board: hit.board });
    }
    await sql`INSERT INTO mca.career_site_check (employer_norm, checked_at, site, found)
              VALUES (${row.employer_norm}, now(), ${d.site}, ${JSON.stringify(d.found)}::jsonb)
              ON CONFLICT (employer_norm) DO UPDATE SET checked_at = now(), site = EXCLUDED.site, found = EXCLUDED.found`;
  }
  return report;
}
