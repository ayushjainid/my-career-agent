// Four more public job-board systems, so employers outside Greenhouse, Lever and Ashby are visible:
//   Workday         https://{tenant}.wd{N}.myworkdayjobs.com  (most large US employers)
//   SmartRecruiters https://api.smartrecruiters.com/v1/companies/{id}/postings
//   Workable        https://apply.workable.com/api/v1/widget/accounts/{account}?details=true
//   Recruitee       https://{company}.recruitee.com/api/offers/  (common in Europe, Milan included)
//
// Workday and SmartRecruiters list titles in pages and need one more request per job for its text.
// To stay polite on huge boards (10,000+ roles), only tech-titled jobs get that request; jobs
// already stored and still listed are just marked seen ("touch"), and new ones beyond the
// per-run cap are fetched on later runs. A listing that couldn't be read to the end is marked
// incomplete, and ingestion then closes nothing for that company.

import { parsePayFromText, type NormalizedJob, type PayRange, type RemoteType } from "@my-career-agent/core";
import { guardedDescription } from "../lib/html.js";
import { paceMs } from "../lib/robots.js";

export class BoardGoneError extends Error {}

export interface BoardResult {
  jobs: NormalizedJob[];
  /** Ids still listed and already stored with full details: only last_seen_at needs updating. */
  touch: string[];
  /** False when the listing wasn't read to the end: don't close anything. */
  complete: boolean;
  /** How many jobs the listing had (for probes), when the reader knows. */
  listed?: number;
  /** A few job addresses the reader would fetch next (for probes). */
  sample?: string[];
}
export interface FetchOpts {
  /** Open job ids already stored for this company (their details aren't fetched again). */
  known?: Set<string>;
  /** Most job detail requests this run, per board. */
  maxDetails?: number;
  /** Most listing pages read, per board. */
  maxPages?: number;
  fetcher?: typeof fetch;
}

const UA = { "user-agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)", accept: "application/json" };

/** Titles worth a detail request on huge boards: the roles this app is for. */
export const TECH_TITLE = /\b(engineer|engineering|developer|software|programmer|data|scientist|science|machine learning|\bml\b|\bai\b|analytics|analyst|architect|devops|sre|site reliability|platform|infrastructure|cloud|security|cyber|product manager|technical|technology|qa|quality assurance|test|sdet|firmware|embedded|mobile|ios|android|frontend|front-end|backend|back-end|full[- ]?stack|database|network)\b/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
function toIso(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.replace(" UTC", "Z").replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2");
    if (!Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  }
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}
function remoteFrom(...hints: Array<string | null | undefined | boolean>): RemoteType {
  const h = hints.filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (/\bhybrid\b/.test(h)) return "hybrid";
  if (/\bremote\b/.test(h)) return "remote";
  if (/on-?site|in[- ]office/.test(h)) return "onsite";
  return "unknown";
}
async function getJson(url: string, f: typeof fetch, init: RequestInit = {}): Promise<unknown> {
  const r = await f(url, { ...init, headers: { ...UA, ...(init.headers as Record<string, string> | undefined) } });
  if (r.status === 404 || r.status === 410) throw new BoardGoneError(`${url} not found`);
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}
/** Runs at most `n` promises at a time. */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

// ------------------------------------------------------------------ Workday

/** "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite" → host, tenant, site. */
export function workdayParts(board: string): { host: string; tenant: string; site: string } | null {
  const m = /^(?:https?:\/\/)?([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)\/?$/.exec(board.trim());
  return m ? { host: `${m[1]}.${m[2]}.myworkdayjobs.com`, tenant: m[1]!, site: m[3]! } : null;
}

interface WdListItem { title: string; externalPath: string; locationsText?: string }

export function parseWorkdayDetail(body: unknown, item: WdListItem, base: string): NormalizedJob | null {
  const info = isObj(body) && isObj(body.jobPostingInfo) ? body.jobPostingInfo : null;
  if (!info) return null;
  const title = str(info.title) ?? item.title;
  const id = str(info.jobReqId) ?? str(info.id) ?? item.externalPath;
  const { text, integrity } = guardedDescription([{ html: str(info.jobDescription) }]);
  const extra = Array.isArray(info.additionalLocations) ? info.additionalLocations.filter((x): x is string => typeof x === "string") : [];
  const location = [str(info.location) ?? item.locationsText ?? null, ...extra].filter(Boolean).join("; ") || null;
  return {
    atsVendor: "workday",
    atsJobId: id,
    title,
    locationText: location,
    remoteType: remoteFrom(str(info.remoteType), location, title),
    pay: parsePayFromText(text),
    postedAt: toIso(info.startDate),
    applyUrl: str(info.externalUrl) ?? `${base}${item.externalPath}`,
    descriptionText: text,
    integrity,
  };
}

export async function fetchWorkday(board: string, opts: FetchOpts = {}): Promise<BoardResult> {
  const p = workdayParts(board);
  if (!p) throw new Error(`workday board "${board}" should look like tenant.wd5.myworkdayjobs.com/SiteName`);
  const f = opts.fetcher ?? fetch;
  const api = `https://${p.host}/wday/cxs/${p.tenant}/${p.site}`;
  const items: WdListItem[] = [];
  const maxPages = opts.maxPages ?? 50;
  // The count Workday reports decides completeness; a short or empty page before that count is
  // reached (a hiccup, a rate limit) must never read as "these jobs are gone".
  let reported: number | null = null;
  let ended = false;
  const gap = (opts as { gapMs?: number }).gapMs ?? paceMs(600);
  let refused = false;
  for (let page = 0; page < maxPages; page++) {
    let body: unknown;
    try {
      body = await getJson(`${api}/jobs`, f, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText: "" }),
      });
    } catch (e) {
      // Workday answers bursts with 429: stop here, keep what was read, and close nothing.
      if (page > 0 && /HTTP (429|403|503)/.test((e as Error).message)) { refused = true; break; }
      throw e;
    }
    if (gap) await new Promise((r) => setTimeout(r, gap));
    const posts = isObj(body) && Array.isArray(body.jobPostings) ? body.jobPostings.filter(isObj) : [];
    if (page === 0 && isObj(body)) reported = num(body.total);
    for (const j of posts) {
      const title = str(j.title), path = str(j.externalPath);
      if (title && path) items.push({ title, externalPath: path, locationsText: str(j.locationsText) ?? undefined });
    }
    if (posts.length < 20) { ended = true; break; }
    if (reported !== null && items.length >= Math.min(reported, 2000)) { ended = true; break; }
  }
  // Workday's search stops at 2,000 results (past that it starts again from page 1), so a reported
  // total of 2,000 or more means the listing is cut short.
  const complete = !refused && ended && (reported === null ? items.length > 0 : items.length >= reported && reported < 2000);
  // The id stored is the requisition id from the detail; the list's bulletFields usually carry it
  // too, but not reliably, so known jobs are matched by their path instead.
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [];
  const todo: WdListItem[] = [];
  for (const it of items) {
    if (known.has(it.externalPath)) touch.push(it.externalPath);
    else if (TECH_TITLE.test(it.title)) todo.push(it);
  }
  const base = `https://${p.host}/en-US/${p.site}`;
  let slowed = false;
  const details = await mapLimit(todo.slice(0, opts.maxDetails ?? 150), 2, async (it) => {
    if (slowed) return null;
    try {
      const d = parseWorkdayDetail(await getJson(`${api}${it.externalPath}`, f), it, base);
      if (gap) await new Promise((r) => setTimeout(r, gap));
      return d;
    } catch (e) { if (/HTTP (429|403|503)/.test((e as Error).message)) slowed = true; return null; }
  });
  // Workday jobs are keyed by their path, which is stable and what the list returns.
  const jobs = details.flatMap((j, k) => (j ? [{ ...j, atsJobId: todo[k]!.externalPath }] : []));
  return { jobs, touch, complete };
}

// ------------------------------------------------------------------ SmartRecruiters

export function parseSmartRecruitersDetail(body: unknown): NormalizedJob | null {
  if (!isObj(body)) return null;
  const id = str(body.id) ?? (body.id != null ? String(body.id) : null);
  const title = str(body.name);
  if (!id || !title) return null;
  const loc = isObj(body.location) ? body.location : {};
  const location = [str(loc.city), str(loc.region), str(loc.country)?.toUpperCase()].filter(Boolean).join(", ") || null;
  const sections = isObj(body.jobAd) && isObj(body.jobAd.sections) ? body.jobAd.sections : {};
  const part = (k: string) => (isObj(sections[k]) ? str((sections[k] as Obj).text) : null);
  const { text, integrity } = guardedDescription([
    { html: part("jobDescription") }, { html: part("qualifications") }, { html: part("additionalInformation") },
  ]);
  return {
    atsVendor: "smartrecruiters",
    atsJobId: id,
    title,
    locationText: location,
    remoteType: loc.remote === true ? "remote" : remoteFrom(location, title),
    pay: parsePayFromText(text),
    postedAt: toIso(body.releasedDate),
    applyUrl: str(body.applyUrl) ?? str(body.postingUrl),
    descriptionText: text,
    integrity,
  };
}

export async function fetchSmartRecruiters(company: string, opts: FetchOpts = {}): Promise<BoardResult> {
  const f = opts.fetcher ?? fetch;
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings`;
  const list: Array<{ id: string; name: string }> = [];
  let reported: number | null = null;
  let ended = false;
  const maxPages = opts.maxPages ?? 20;
  for (let page = 0; page < maxPages; page++) {
    const body = await getJson(`${base}?limit=100&offset=${page * 100}`, f);
    const content = isObj(body) && Array.isArray(body.content) ? body.content.filter(isObj) : [];
    if (page === 0 && isObj(body)) reported = num(body.totalFound);
    for (const j of content) { const id = j.id != null ? String(j.id) : null, name = str(j.name); if (id && name) list.push({ id, name }); }
    if (content.length < 100 || (reported !== null && list.length >= reported)) { ended = true; break; }
  }
  const total = ended && (reported === null || list.length >= reported) ? list.length : Infinity;
  // An empty first page from an unknown company id looks the same as a real empty board.
  const known = opts.known ?? new Set<string>();
  const touch = list.filter((j) => known.has(j.id)).map((j) => j.id);
  const todo = list.filter((j) => !known.has(j.id) && TECH_TITLE.test(j.name));
  const cap = opts.maxDetails ?? 150;
  const details = await mapLimit(todo.slice(0, cap), 4, async (j) => {
    try { return parseSmartRecruitersDetail(await getJson(`${base}/${encodeURIComponent(j.id)}`, f)); } catch { return null; }
  });
  return { jobs: details.filter((j): j is NormalizedJob => !!j), touch, complete: list.length >= total && todo.length <= cap };
}

// ------------------------------------------------------------------ Workable

export function parseWorkable(body: unknown): NormalizedJob[] {
  const jobs = isObj(body) && Array.isArray(body.jobs) ? body.jobs.filter(isObj) : [];
  return jobs.flatMap((j): NormalizedJob[] => {
    const id = str(j.shortcode) ?? str(j.code);
    const title = str(j.title);
    if (!id || !title) return [];
    const locs = Array.isArray(j.locations) ? j.locations.filter(isObj).filter((l) => l.hidden !== true) : [];
    const location = (locs.length ? locs.map((l) => [str(l.city), str(l.region), str(l.country)].filter(Boolean).join(", ")) : [[str(j.city), str(j.state), str(j.country)].filter(Boolean).join(", ")])
      .filter(Boolean).join("; ") || null;
    const { text, integrity } = guardedDescription([{ html: str(j.description) }]);
    return [{
      atsVendor: "workable",
      atsJobId: id,
      title,
      locationText: location,
      remoteType: j.telecommuting === true ? "remote" : remoteFrom(str(j.workplace), location, title),
      pay: parsePayFromText(text),
      postedAt: toIso(j.published_on) ?? toIso(j.created_at),
      applyUrl: str(j.application_url) ?? str(j.url) ?? str(j.shortlink),
      descriptionText: text,
      integrity,
    }];
  });
}
export async function fetchWorkable(account: string, opts: FetchOpts = {}): Promise<BoardResult> {
  const body = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`, opts.fetcher ?? fetch);
  return { jobs: parseWorkable(body), touch: [], complete: true };
}

// ------------------------------------------------------------------ Recruitee

export function parseRecruitee(body: unknown): NormalizedJob[] {
  const offers = isObj(body) && Array.isArray(body.offers) ? body.offers.filter(isObj) : [];
  return offers.flatMap((o): NormalizedJob[] => {
    const id = o.id != null ? String(o.id) : null;
    const title = str(o.title);
    if (!id || !title) return [];
    if (o.status && o.status !== "published") return [];
    const location = str(o.location) ?? ([str(o.city), str(o.country)].filter(Boolean).join(", ") || null);
    const { text, integrity } = guardedDescription([{ html: str(o.description) }, { html: str(o.requirements) }]);
    let pay: PayRange | null = null;
    if (isObj(o.salary) && (num(o.salary.min) !== null || num(o.salary.max) !== null)) {
      const per = String(o.salary.period ?? "year");
      pay = { min: num(o.salary.min), max: num(o.salary.max), currency: str(o.salary.currency), period: /hour/.test(per) ? "hour" : /month/.test(per) ? "month" : "year", source: "structured" };
    }
    return [{
      atsVendor: "recruitee",
      atsJobId: id,
      title,
      locationText: location,
      remoteType: o.remote === true ? "remote" : o.hybrid === true ? "hybrid" : o.on_site === true ? "onsite" : remoteFrom(location, title),
      pay: pay ?? parsePayFromText(text),
      postedAt: toIso(o.published_at) ?? toIso(o.created_at),
      applyUrl: str(o.careers_apply_url) ?? str(o.careers_url),
      descriptionText: text,
      integrity,
    }];
  });
}
export async function fetchRecruitee(company: string, opts: FetchOpts = {}): Promise<BoardResult> {
  if (!/^[a-z0-9-]+$/i.test(company)) throw new Error(`recruitee board "${company}" should be the subdomain, e.g. "acme"`);
  const body = await getJson(`https://${company.toLowerCase()}.recruitee.com/api/offers/`, opts.fetcher ?? fetch);
  return { jobs: parseRecruitee(body), touch: [], complete: true };
}
