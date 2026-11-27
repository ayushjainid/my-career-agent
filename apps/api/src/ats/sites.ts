// Employers' own career sites with public JSON behind their search pages. Each was checked from a
// GitHub runner, robots.txt included (scripts/probe-urls.mts), before being added here.
//
//   amazon     https://www.amazon.jobs/en/search.json            board "amazon"
//   eightfold  https://{host}/api/pcsx/search (Microsoft) or /api/apply/v2/jobs (Netflix and others)
//              board "{host}|{domain}", e.g. "apply.careers.microsoft.com|microsoft.com"
//   oracle     https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions (Oracle
//              Recruiting Cloud: JPMorgan and many banks). board "{host}|{siteNumber}"
//
// The app serves five countries, so only jobs there, and only tech-titled ones, get a detail
// request. Requests are spaced out, and a refusal (429/403) ends the run for that board with
// what was read so far marked incomplete, so nothing is closed by mistake.

import { parsePayFromText, type NormalizedJob, type RemoteType } from "@my-career-agent/core";
import { guardedDescription } from "../lib/html.js";
import { paceMs } from "../lib/robots.js";
import { BoardGoneError, TECH_TITLE, type BoardResult, type FetchOpts } from "./more.js";

const UA = { "user-agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)", accept: "application/json" };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SlowDownError extends Error {}

/** One polite GET/POST: spaced out by the caller; 429/403/503 stop the board for this run. */
async function getJson(url: string, f: typeof fetch, init: RequestInit = {}): Promise<unknown> {
  const r = await f(url, { ...init, headers: { ...UA, ...(init.headers as Record<string, string> | undefined) } });
  if (!r.ok) await r.body?.cancel().catch(() => {}); // an unread body can crash Node's HTTP client
  if (r.status === 404 || r.status === 410) throw new BoardGoneError(`${url} not found`);
  if (r.status === 429 || r.status === 403 || r.status === 503) throw new SlowDownError(`${new URL(url).host} HTTP ${r.status}`);
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}

function remoteFrom(...hints: Array<string | null | undefined>): RemoteType {
  const h = hints.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(h)) return "hybrid";
  if (/\bremote\b|work from home|telecommut/.test(h)) return "remote";
  if (/on-?site|in[- ]office/.test(h)) return "onsite";
  return "unknown";
}
const isoDate = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

/** Country codes the app serves, in the spellings these sites use. */
export const TARGET_ISO2 = new Set(["US", "GB", "IE", "CA", "IT"]);
const TARGET_NAMES = /\b(united states|usa|united kingdom|uk|england|scotland|wales|northern ireland|ireland|canada|italy|italia)\b/i;

// ------------------------------------------------------------------ Amazon

/** Amazon's tech job families; each query must stay under the site's 10,000-result cap. */
const AMAZON_CATEGORIES = [
  "software-development", "machine-learning-science", "data-science", "research-science", "solutions-architect",
  "systems-quality-security-engineering", "project-program-product-management-technical", "hardware-development",
  "business-intelligence", "database-administration", "operations-it-support-engineering", "economics",
];
const AMAZON_COUNTRIES = ["USA", "GBR", "IRL", "CAN", "ITA"];

export function parseAmazonJob(j: unknown): NormalizedJob | null {
  if (!isObj(j)) return null;
  const id = str(j.id_icims) ?? (j.id_icims != null ? String(j.id_icims) : null) ?? str(j.id);
  const title = str(j.title);
  if (!id || !title) return null;
  const { text, integrity } = guardedDescription([
    { html: str(j.description) },
    { html: str(j.basic_qualifications) ? `<h3>Basic qualifications</h3>${j.basic_qualifications}` : null },
    { html: str(j.preferred_qualifications) ? `<h3>Preferred qualifications</h3>${j.preferred_qualifications}` : null },
  ]);
  const location = str(j.normalized_location) ?? str(j.location);
  return {
    atsVendor: "amazon",
    atsJobId: id,
    title,
    locationText: location,
    remoteType: remoteFrom(location, title),
    pay: parsePayFromText(text),
    postedAt: isoDate(j.posted_date),
    applyUrl: str(j.job_path) ? `https://www.amazon.jobs${j.job_path}` : `https://www.amazon.jobs/en/jobs/${id}`,
    descriptionText: text,
    integrity,
  };
}

export async function fetchAmazon(_board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult> {
  const f = opts.fetcher ?? fetch;
  const gap = opts.gapMs ?? paceMs(400);
  const seen = new Map<string, NormalizedJob>();
  let complete = true;
  const maxPages = opts.maxPages ?? 100;
  let pages = 0;
  outer: for (const country of AMAZON_COUNTRIES) {
    for (const cat of AMAZON_CATEGORIES) {
      let offset = 0, hits: number | null = null, got = 0;
      for (;;) {
        if (pages++ >= maxPages) { complete = false; break outer; }
        let body: unknown;
        try {
          body = await getJson(`https://www.amazon.jobs/en/search.json?result_limit=100&offset=${offset}&sort=recent&country=${country}&category[]=${cat}`, f);
        } catch (e) {
          complete = false;
          if (e instanceof SlowDownError) break outer;
          break;
        }
        const list = isObj(body) && Array.isArray(body.jobs) ? body.jobs : [];
        if (hits === null && isObj(body)) hits = num(body.hits);
        for (const j of list) { const n = parseAmazonJob(j); if (n) seen.set(n.atsJobId, n); }
        got += list.length;
        offset += list.length;
        await sleep(gap);
        if (list.length < 100 || (hits !== null && got >= hits)) break;
        if (offset >= 10000) { complete = false; break; }
      }
      if (hits !== null && got < hits) complete = false;
    }
  }
  return { jobs: [...seen.values()], touch: [], complete };
}

// ------------------------------------------------------------------ Eightfold

export function eightfoldParts(board: string): { host: string; domain: string } | null {
  const [host, domain] = board.split("|").map((s) => s.trim());
  return host && domain ? { host, domain } : null;
}

interface EfItem { id: string; title: string; locations: string[]; posted: string | null; remote: string | null; desc: string | null; url: string | null }

function efItem(p: Obj, host: string): EfItem | null {
  const id = p.id != null ? String(p.id) : null;
  const title = str(p.name) ?? str(p.title);
  if (!id || !title) return null;
  const locs = (Array.isArray(p.standardizedLocations) && p.standardizedLocations.length ? p.standardizedLocations : Array.isArray(p.locations) ? p.locations : [str(p.location)])
    .filter((x): x is string => typeof x === "string");
  const url = str(p.canonicalPositionUrl) ?? (str(p.positionUrl) ? `https://${host}${p.positionUrl}` : null);
  return { id, title, locations: locs, posted: isoDate(p.postedTs ?? p.t_create), remote: str(p.workLocationOption) ?? str(p.location_flexibility),
    desc: str(p.jobDescription) ?? str(p.job_description), url };
}

const efInTarget = (it: EfItem) => it.locations.some((l) => TARGET_NAMES.test(l) || /,\s*(US|GB|IE|CA|IT)\s*$/.test(l)) || it.locations.length === 0;

export async function fetchEightfold(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult> {
  const p = eightfoldParts(board);
  if (!p) throw new Error(`eightfold board "${board}" should look like host|domain`);
  const f = opts.fetcher ?? fetch;
  // Eightfold sites rate-limit quickly (Microsoft answered 429 after a few hundred requests).
  const gap = opts.gapMs ?? paceMs(1500);
  const items: EfItem[] = [];
  let complete = false, reported: number | null = null, pcsx = true;
  const maxPages = opts.maxPages ?? 400;
  try {
    for (let page = 0, start = 0; page < maxPages; page++) {
      let body: unknown;
      if (pcsx) {
        try {
          body = await getJson(`https://${p.host}/api/pcsx/search?domain=${encodeURIComponent(p.domain)}&query=&location=&start=${start}&sort_by=timestamp`, f);
        } catch (e) {
          // Sites on the older API refuse the newer one (403/404); a 429 is a request to slow down.
          if (page === 0 && !/HTTP 429/.test((e as Error).message)) { pcsx = false; page--; continue; }
          throw e;
        }
      } else {
        body = await getJson(`https://${p.host}/api/apply/v2/jobs?domain=${encodeURIComponent(p.domain)}&start=${start}&num=100&sort_by=timestamp`, f);
      }
      const data = isObj(body) && isObj(body.data) ? body.data : isObj(body) ? body : {};
      const list = Array.isArray(data.positions) ? data.positions.filter(isObj) : [];
      // Sites on Eightfold's older API answer the newer one with an empty list.
      if (pcsx && page === 0 && !list.length) { pcsx = false; page--; continue; }
      if (reported === null) reported = num(data.count) ?? num(data.total) ?? num(data.totalCount);
      for (const x of list) { const it = efItem(x, p.host); if (it) items.push(it); }
      start += list.length;
      await sleep(gap);
      if (!list.length || (reported !== null && start >= reported)) { complete = reported === null ? items.length > 0 : start >= reported; break; }
    }
  } catch (e) {
    if (!(e instanceof SlowDownError) && items.length === 0) throw e;
    complete = false;
  }
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [];
  const todo: EfItem[] = [];
  for (const it of items) {
    if (known.has(it.id)) touch.push(it.id);
    else if (TECH_TITLE.test(it.title) && efInTarget(it)) todo.push(it);
  }
  const cap = opts.maxDetails ?? 200;
  const jobs: NormalizedJob[] = [];
  let lastError: string | undefined;
  for (const it of todo.slice(0, cap)) {
    let desc = it.desc;
    let url = it.url;
    if (!desc) {
      try {
        const d = await getJson(pcsx
          ? `https://${p.host}/api/pcsx/position_details?position_id=${it.id}&domain=${encodeURIComponent(p.domain)}&hl=en`
          : `https://${p.host}/api/apply/v2/jobs/${it.id}?domain=${encodeURIComponent(p.domain)}`, f);
        const dd = isObj(d) && isObj(d.data) ? d.data : isObj(d) ? d : {};
        desc = str(dd.jobDescription) ?? str(dd.job_description);
        url = str(dd.publicUrl) ?? str(dd.canonicalPositionUrl) ?? url;
      } catch (e) {
        lastError = (e as Error).message;
        if (e instanceof SlowDownError) { complete = false; break; }
        continue;
      }
      await sleep(gap);
    }
    const { text, integrity } = guardedDescription([{ html: desc }]);
    const location = it.locations.join("; ") || null;
    jobs.push({ atsVendor: "eightfold", atsJobId: it.id, title: it.title, locationText: location, remoteType: remoteFrom(it.remote, location, it.title),
      pay: parsePayFromText(text), postedAt: it.posted, applyUrl: url ?? `https://${p.host}/careers/job/${it.id}`, descriptionText: text, integrity });
  }
  // Completeness is about the listing: a job whose details failed simply isn't stored yet.
  return { jobs, touch, complete, listed: items.length, sample: [`todo ${todo.length}`, `pcsx ${pcsx}`, ...(lastError ? [lastError] : [])] };
}

// ------------------------------------------------------------------ Oracle Recruiting Cloud

export function oracleParts(board: string): { host: string; site: string } | null {
  const [host, site] = board.split("|").map((s) => s.trim());
  return host && site ? { host, site } : null;
}

export async function fetchOracle(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult> {
  const p = oracleParts(board);
  if (!p) throw new Error(`oracle board "${board}" should look like host|siteNumber`);
  const f = opts.fetcher ?? fetch;
  const gap = opts.gapMs ?? paceMs(400);
  const api = `https://${p.host}/hcmRestApi/resources/latest`;
  type Item = { id: string; title: string; location: string | null; country: string | null; posted: string | null; workplace: string | null };
  const items: Item[] = [];
  let reported: number | null = null, complete = false;
  const maxPages = opts.maxPages ?? 200;
  try {
    for (let page = 0, offset = 0; page < maxPages; page++) {
      const body = await getJson(`${api}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${p.site},limit=100,offset=${offset},sortBy=POSTING_DATES_DESC`, f);
      const search = isObj(body) && Array.isArray(body.items) && isObj(body.items[0]) ? body.items[0] : {};
      if (reported === null) reported = num(search.TotalJobsCount);
      const list = Array.isArray(search.requisitionList) ? search.requisitionList.filter(isObj) : [];
      for (const r of list) {
        const id = str(r.Id) ?? (r.Id != null ? String(r.Id) : null), title = str(r.Title);
        if (!id || !title) continue;
        const sec = Array.isArray(r.secondaryLocations) ? r.secondaryLocations.filter(isObj).map((s) => str(s.Name)).filter((x): x is string => !!x) : [];
        items.push({ id, title, location: [str(r.PrimaryLocation), ...sec].filter(Boolean).join("; ") || null, country: str(r.PrimaryLocationCountry),
          posted: isoDate(r.PostedDate), workplace: str(r.WorkplaceType) });
      }
      offset += list.length;
      await sleep(gap);
      if (!list.length || (reported !== null && offset >= reported)) { complete = reported === null ? items.length > 0 : offset >= reported; break; }
    }
  } catch (e) {
    if (!(e instanceof SlowDownError) && items.length === 0) throw e;
    complete = false;
  }
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [];
  const todo: Item[] = [];
  for (const it of items) {
    if (known.has(it.id)) touch.push(it.id);
    else if (TECH_TITLE.test(it.title) && (!it.country || TARGET_ISO2.has(it.country.toUpperCase()))) todo.push(it);
  }
  const cap = opts.maxDetails ?? 200;
  const jobs: NormalizedJob[] = [];
  for (const it of todo.slice(0, cap)) {
    let d: unknown;
    try {
      d = await getJson(`${api}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${it.id}%22,siteNumber=${p.site}`, f);
    } catch (e) {
      if (e instanceof SlowDownError) { complete = false; break; }
      continue;
    }
    await sleep(gap);
    const x = isObj(d) && Array.isArray(d.items) && isObj(d.items[0]) ? d.items[0] : {};
    const { text, integrity } = guardedDescription([
      { html: str(x.ExternalDescriptionStr) },
      { html: str(x.ExternalResponsibilitiesStr) },
      { html: str(x.ExternalQualificationsStr) },
    ]);
    jobs.push({ atsVendor: "oracle", atsJobId: it.id, title: it.title, locationText: it.location, remoteType: remoteFrom(it.workplace, it.location, it.title),
      pay: parsePayFromText(text), postedAt: it.posted, applyUrl: `https://${p.host}/hcmUI/CandidateExperience/en/sites/${p.site}/job/${it.id}`, descriptionText: text, integrity });
  }
  // Completeness is about the listing: a job whose details failed simply isn't stored yet.
  return { jobs, touch, complete };
}
