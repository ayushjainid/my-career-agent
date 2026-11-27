// More public job feeds, plus a generic reader for career sites that publish a sitemap of jobs with
// schema.org JobPosting data on each job page (the data Google for Jobs reads).
//
//   teamtailor  https://{t}.teamtailor.com/jobs.json        JSON Feed, each item a JobPosting
//   personio    https://{t}.jobs.personio.de/xml            XML, whole board
//   bamboohr    https://{t}.bamboohr.com/careers/list       list; /careers/{id}/detail per job
//   rippling    https://api.rippling.com/platform/api/ats/v1/board/{t}/jobs   list; /jobs/{uuid} per job
//   breezy      https://{t}.breezy.hr/json                  list; the job page's JobPosting for the text
//   sitemap     board "{sitemap url}|{job url pattern}", e.g. "https://jobs.citi.com/sitemap.xml|/job/"
//               Radancy (TalentBrew) sites, JazzHR and many custom sites work this way.
//
// Endpoint formats follow github.com/danielhagever/job-board-apis (tested catalogue). Every request
// goes through the caller's fetcher, which in production honours robots.txt and its Crawl-delay.

import { parsePayFromText, type NormalizedJob, type PayRange, type RemoteType } from "@my-career-agent/core";
import { guardedDescription } from "../lib/html.js";
import { paceMs } from "../lib/robots.js";
import { BoardGoneError, TECH_TITLE, type BoardResult, type FetchOpts } from "./more.js";
import { SlowDownError, TARGET_ISO2 } from "./sites.js";

const UA = { "user-agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)" };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const sleep = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v).toISOString() : null);

async function get(url: string, f: typeof fetch, accept = "application/json"): Promise<Response> {
  const r = await f(url, { headers: { ...UA, accept }, redirect: "follow" });
  if (r.status === 404 || r.status === 410) throw new BoardGoneError(`${url} not found`);
  if (r.status === 429 || r.status === 403 || r.status === 503) throw new SlowDownError(`${new URL(url).host} HTTP ${r.status}`);
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r;
}
async function getJson(url: string, f: typeof fetch): Promise<unknown> {
  const r = await get(url, f);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new BoardGoneError(`${url} did not answer JSON`); }
}
async function getText(url: string, f: typeof fetch, accept = "text/html,application/xml;q=0.9,*/*;q=0.5"): Promise<string> {
  const r = await get(url, f, accept);
  if (url.endsWith(".gz") && r.body && typeof DecompressionStream !== "undefined" && !/gzip/.test(r.headers.get("content-encoding") ?? "")) {
    return await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return await r.text();
}
function remoteFrom(...hints: Array<string | null | undefined | boolean>): RemoteType {
  const h = hints.map((x) => (x === true ? "remote" : x)).filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (/\bhybrid\b/.test(h)) return "hybrid";
  if (/\bremote\b|telecommute/.test(h)) return "remote";
  if (/on-?site|in[- ]office/.test(h)) return "onsite";
  return "unknown";
}

// ------------------------------------------------------------------ schema.org JobPosting

const COUNTRY_NAMES: Record<string, string> = { "united states": "US", usa: "US", "united states of america": "US", us: "US", "united kingdom": "GB", uk: "GB", gb: "GB",
  england: "GB", scotland: "GB", wales: "GB", ireland: "IE", ie: "IE", canada: "CA", ca: "CA", italy: "IT", italia: "IT", it: "IT" };
export function countryCode(v: unknown): string | null {
  const s = (isObj(v) ? str(v.name) ?? str(v["@id"]) : str(v))?.toLowerCase();
  if (!s) return null;
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  if (/^[a-z]{3}$/.test(s)) return ({ usa: "US", gbr: "GB", irl: "IE", can: "CA", ita: "IT" } as Record<string, string>)[s] ?? s.toUpperCase();
  return COUNTRY_NAMES[s] ?? null;
}

/** Every JobPosting object in a page's ld+json blocks. */
export function jobPostingsIn(html: string): Obj[] {
  const out: Obj[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!isObj(v)) return;
    const t = v["@type"];
    if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) out.push(v);
    if (Array.isArray(v["@graph"])) visit(v["@graph"]);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1]!.trim())); } catch { /* a broken block is skipped */ }
  }
  return out;
}

function payFromSchema(bs: unknown): PayRange | null {
  if (!isObj(bs)) return null;
  const v = isObj(bs.value) ? bs.value : bs;
  const min = num(v.minValue) ?? num(v.value), max = num(v.maxValue) ?? num(v.value);
  if (min === null && max === null) return null;
  const unit = (str(v.unitText) ?? "").toUpperCase();
  const period = unit === "YEAR" ? "year" : unit === "MONTH" ? "month" : unit === "HOUR" ? "hour" : "unknown";
  return { min, max, currency: str(bs.currency), period, source: "structured" };
}

/** A JobPosting as a NormalizedJob, with its country (null when it doesn't say). */
export function fromJobPosting(jp: Obj, vendor: NormalizedJob["atsVendor"], id: string, url: string | null): { job: NormalizedJob; country: string | null } | null {
  const title = str(jp.title);
  if (!title) return null;
  const locs = (Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation]).filter(isObj);
  const addr = locs.map((l) => (isObj(l.address) ? l.address : l));
  const place = addr.map((a) => [str(a.addressLocality), str(a.addressRegion), str(isObj(a.addressCountry) ? a.addressCountry.name : a.addressCountry)].filter(Boolean).join(", ")).filter(Boolean);
  const country = addr.map((a) => countryCode(a.addressCountry)).find(Boolean) ?? null;
  const { text, integrity } = guardedDescription([{ html: str(jp.description) }]);
  const remote = str(jp.jobLocationType) === "TELECOMMUTE" ? "remote" : remoteFrom(place.join(" "), title);
  return {
    country,
    job: { atsVendor: vendor, atsJobId: id, title, locationText: place.join("; ") || null, remoteType: remote,
      pay: payFromSchema(jp.baseSalary) ?? parsePayFromText(text), postedAt: iso(jp.datePosted), applyUrl: str(jp.url) ?? url, descriptionText: text, integrity },
  };
}
const inTarget = (country: string | null) => country === null || TARGET_ISO2.has(country);

// ------------------------------------------------------------------ Sitemap + JobPosting

export function sitemapParts(board: string): { url: string; pattern: RegExp } | null {
  const [url, pat] = board.split("|");
  if (!url || !/^https:\/\//.test(url)) return null;
  try { return { url, pattern: new RegExp(pat || "/jobs?/", "i") }; } catch { return null; }
}

function locs(xml: string): Array<{ loc: string; lastmod: string | null }> {
  const out: Array<{ loc: string; lastmod: string | null }> = [];
  for (const m of xml.matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]!)?.[1];
    if (loc) out.push({ loc: loc.replace(/&amp;/g, "&"), lastmod: /<lastmod>\s*([^<\s]+)/.exec(m[1]!)?.[1] ?? null });
  }
  return out;
}

export async function fetchSitemap(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult> {
  const p = sitemapParts(board);
  if (!p) throw new Error(`sitemap board "${board}" should look like https://host/sitemap.xml|pattern`);
  const f = opts.fetcher ?? fetch;
  const gap = opts.gapMs ?? paceMs(500);
  const root = await getText(p.url, f);
  let entries = locs(root);
  let complete = true;
  if (/<sitemapindex/i.test(root)) {
    // An index of sitemaps: read the job ones (or all, when none say "job").
    const subs = entries.map((e) => e.loc);
    const jobSubs = subs.filter((u) => /job|career|position|requisition/i.test(u));
    entries = [];
    for (const u of (jobSubs.length ? jobSubs : subs).slice(0, 40)) {
      try { entries.push(...locs(await getText(u, f))); } catch (e) { complete = false; if (e instanceof SlowDownError) break; }
      await sleep(gap);
    }
  }
  const jobs = entries.filter((e) => p.pattern.test(new URL(e.loc, p.url).pathname));
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [];
  const todo: string[] = [];
  for (const e of jobs) {
    const id = new URL(e.loc).pathname;
    if (known.has(id)) touch.push(id);
    else if (TECH_TITLE.test(decodeURIComponent(id).replace(/[-_/+]/g, " "))) todo.push(e.loc);
  }
  const out: NormalizedJob[] = [];
  for (const url of todo.slice(0, opts.maxDetails ?? 150)) {
    let html: string;
    try { html = await getText(url, f); } catch (e) { if (e instanceof SlowDownError) break; continue; }
    await sleep(gap);
    const jp = jobPostingsIn(html)[0];
    const n = jp && fromJobPosting(jp, "sitemap", new URL(url).pathname, url);
    if (n && inTarget(n.country)) out.push(n.job);
  }
  return { jobs: out, touch, complete: complete && jobs.length > 0 };
}

// ------------------------------------------------------------------ Teamtailor

export async function fetchTeamtailor(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult & { name: string | null }> {
  const f = opts.fetcher ?? fetch;
  const host = board.includes(".") ? board : `${board}.teamtailor.com`;
  let url: string | null = `https://${host}/jobs.json`;
  const jobs: NormalizedJob[] = [];
  let name: string | null = null, pages = 0, complete = false;
  while (url && pages++ < (opts.maxPages ?? 30)) {
    const body = await getJson(url, f);
    if (!isObj(body)) throw new BoardGoneError(`${host} answered no feed`);
    name ??= str(body.title);
    for (const it of Array.isArray(body.items) ? body.items.filter(isObj) : []) {
      const jp = isObj(it._jobposting) ? it._jobposting : { "@type": "JobPosting", title: it.title, description: it.content_html, datePosted: it.date_published };
      const n = fromJobPosting(jp as Obj, "teamtailor", String(it.id ?? it.url), str(it.url));
      if (n && inTarget(n.country)) jobs.push(n.job);
    }
    url = str(body.next_url);
    if (!url) complete = true;
    await sleep(opts.gapMs ?? paceMs(300));
  }
  return { jobs, touch: [], complete, name };
}

// ------------------------------------------------------------------ Personio

const xmlText = (block: string, tag: string) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : null;
};

export function parsePersonio(xml: string, host: string): NormalizedJob[] {
  const out: NormalizedJob[] = [];
  for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/g)) {
    const b = m[1]!;
    const id = xmlText(b, "id"), title = xmlText(b, "name");
    if (!id || !title) continue;
    const parts = [...b.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map((d) => {
      const h = xmlText(d[1]!, "name"), v = xmlText(d[1]!, "value");
      return { html: `${h ? `<h3>${h}</h3>` : ""}${v ?? ""}` };
    });
    const { text, integrity } = guardedDescription(parts);
    const offices = [xmlText(b, "office"), ...[...b.matchAll(/<office>([^<]+)<\/office>/g)].map((o) => o[1]!)].filter(Boolean) as string[];
    const location = [...new Set(offices)].join("; ") || null;
    out.push({ atsVendor: "personio", atsJobId: id, title, locationText: location, remoteType: remoteFrom(xmlText(b, "schedule"), location, title),
      pay: parsePayFromText(text), postedAt: iso(xmlText(b, "createdAt")), applyUrl: `https://${host}/job/${id}`, descriptionText: text, integrity });
  }
  return out;
}

export async function fetchPersonio(board: string, opts: FetchOpts = {}): Promise<BoardResult> {
  const host = board.includes(".") ? board : `${board}.jobs.personio.de`;
  const xml = await getText(`https://${host}/xml?language=en`, opts.fetcher ?? fetch, "application/xml");
  if (!/<workzag-jobs/i.test(xml)) throw new BoardGoneError(`${host} answered no Personio feed`);
  return { jobs: parsePersonio(xml, host), touch: [], complete: true };
}

// ------------------------------------------------------------------ BambooHR

export async function fetchBambooHR(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult> {
  const f = opts.fetcher ?? fetch;
  const base = `https://${board}.bamboohr.com/careers`;
  const body = await getJson(`${base}/list`, f);
  const list = isObj(body) && Array.isArray(body.result) ? body.result.filter(isObj) : null;
  if (!list) throw new BoardGoneError(`${board}.bamboohr.com answered no list`);
  const total = isObj(body) && isObj(body.meta) ? num(body.meta.totalCount) : null;
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [], todo: Obj[] = [];
  for (const j of list) {
    const id = str(j.id), title = str(j.jobOpeningName);
    if (!id || !title) continue;
    if (known.has(id)) touch.push(id); else if (TECH_TITLE.test(title)) todo.push(j);
  }
  const jobs: NormalizedJob[] = [];
  for (const j of todo.slice(0, opts.maxDetails ?? 100)) {
    let d: unknown;
    try { d = await getJson(`${base}/${j.id}/detail`, f); } catch (e) { if (e instanceof SlowDownError) break; continue; }
    await sleep(opts.gapMs ?? paceMs(300));
    const o = isObj(d) && isObj(d.result) && isObj(d.result.jobOpening) ? d.result.jobOpening : {};
    const loc = isObj(o.location) ? o.location : isObj(j.location) ? j.location : {};
    const location = [str(loc.city), str(loc.state), str(loc.addressCountry) ?? str(loc.country)].filter(Boolean).join(", ") || null;
    const { text, integrity } = guardedDescription([{ html: str(o.description) }, { plain: str(o.compensation) ? `Compensation: ${o.compensation}` : null }]);
    jobs.push({ atsVendor: "bamboohr", atsJobId: String(j.id), title: str(o.jobOpeningName) ?? String(j.jobOpeningName), locationText: location,
      remoteType: remoteFrom(j.isRemote === true, str(o.locationType), location), pay: parsePayFromText(text), postedAt: iso(o.datePosted),
      applyUrl: `${base}/${j.id}`, descriptionText: text, integrity });
  }
  return { jobs, touch, complete: total === null || list.length >= total };
}

// ------------------------------------------------------------------ Rippling

export async function fetchRippling(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult> {
  const f = opts.fetcher ?? fetch;
  const api = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(board)}/jobs`;
  const body = await getJson(api, f);
  if (!Array.isArray(body)) throw new BoardGoneError(`rippling board ${board} answered no list`);
  const byId = new Map<string, Obj>();
  for (const j of body.filter(isObj)) { const id = str(j.uuid); if (id && !byId.has(id)) byId.set(id, j); }
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [], todo: Obj[] = [];
  for (const [id, j] of byId) { if (known.has(id)) touch.push(id); else if (TECH_TITLE.test(str(j.name) ?? "")) todo.push(j); }
  const jobs: NormalizedJob[] = [];
  for (const j of todo.slice(0, opts.maxDetails ?? 100)) {
    let d: unknown;
    try { d = await getJson(`${api}/${j.uuid}`, f); } catch (e) { if (e instanceof SlowDownError) break; continue; }
    await sleep(opts.gapMs ?? paceMs(300));
    const o = isObj(d) ? d : {};
    const desc = isObj(o.description) ? [str(o.description.company), str(o.description.role)] : [str(o.description)];
    const { text, integrity } = guardedDescription(desc.map((h) => ({ html: h })));
    const places = (Array.isArray(o.workLocations) ? o.workLocations : [j.workLocation]).map((w) => (isObj(w) ? str(w.label) ?? str(w.name) : str(w))).filter(Boolean) as string[];
    const band = Array.isArray(o.payRangeDetails) && isObj(o.payRangeDetails[0]) ? o.payRangeDetails[0] : null;
    const pay: PayRange | null = band && (num(band.rangeStart) !== null || num(band.rangeEnd) !== null)
      ? { min: num(band.rangeStart), max: num(band.rangeEnd), currency: str(band.currency), period: str(band.frequency) === "HOUR" ? "hour" : str(band.frequency) === "YEAR" ? "year" : "unknown", source: "structured" }
      : parsePayFromText(text);
    jobs.push({ atsVendor: "rippling", atsJobId: String(j.uuid), title: str(o.name) ?? String(j.name), locationText: places.join("; ") || null,
      remoteType: remoteFrom(places.join(" "), str(o.name)), pay, postedAt: iso(o.createdOn), applyUrl: str(j.url), descriptionText: text, integrity });
  }
  return { jobs, touch, complete: true };
}

// ------------------------------------------------------------------ Breezy HR

export async function fetchBreezy(board: string, opts: FetchOpts & { gapMs?: number } = {}): Promise<BoardResult & { name: string | null }> {
  const f = opts.fetcher ?? fetch;
  const body = await getJson(`https://${board}.breezy.hr/json`, f);
  if (!Array.isArray(body)) throw new BoardGoneError(`${board}.breezy.hr answered no list`);
  const list = body.filter(isObj);
  const name = list.map((j) => (isObj(j.company) ? str(j.company.name) : null)).find(Boolean) ?? null;
  const known = opts.known ?? new Set<string>();
  const touch: string[] = [], todo: Obj[] = [];
  for (const j of list) {
    const id = str(j.id) ?? str(j.friendly_id), title = str(j.name);
    if (!id || !title) continue;
    const loc = isObj(j.location) ? j.location : {};
    const country = countryCode(isObj(loc.country) ? loc.country.id ?? loc.country.name : loc.country);
    if (known.has(id)) touch.push(id); else if (TECH_TITLE.test(title) && inTarget(country)) todo.push(j);
  }
  const jobs: NormalizedJob[] = [];
  for (const j of todo.slice(0, opts.maxDetails ?? 100)) {
    const url = str(j.url);
    const loc = isObj(j.location) ? j.location : {};
    let desc: string | null = null;
    if (url) {
      try { const jp = jobPostingsIn(await getText(url, f))[0]; desc = jp ? str(jp.description) : null; } catch (e) { if (e instanceof SlowDownError) break; }
      await sleep(opts.gapMs ?? paceMs(300));
    }
    const { text, integrity } = guardedDescription([{ html: desc }]);
    jobs.push({ atsVendor: "breezy", atsJobId: String(j.id ?? j.friendly_id), title: String(j.name), locationText: str(loc.name),
      remoteType: remoteFrom(loc.is_remote === true, str(loc.name)), pay: parsePayFromText(`${str(j.salary) ?? ""}\n${text}`), postedAt: iso(j.published_date),
      applyUrl: url, descriptionText: text, integrity });
  }
  return { jobs, touch, complete: true, name };
}
