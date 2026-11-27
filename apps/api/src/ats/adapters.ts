// Public, read-only ATS job-board feeds. One request per company board.
//   Greenhouse: https://developers.greenhouse.io/job-board
//   Lever:      https://github.com/lever/postings-api
//   Ashby:      https://developers.ashbyhq.com/docs/public-job-posting-api
// Parsers are tolerant: unknown or missing fields degrade to null rather than throwing.

import { politeFetch } from "../lib/robots.js";
import { fetchAmazon, fetchEightfold, fetchOracle } from "./sites.js";
import { fetchBambooHR, fetchBreezy, fetchPersonio, fetchRippling, fetchSitemap, fetchTeamtailor } from "./feeds.js";
import { parsePayFromText, type AtsVendor, type NormalizedJob, type PayRange, type RemoteType } from "@my-career-agent/core";
import { guardedDescription } from "../lib/html.js";
import { BoardGoneError, fetchRecruitee, fetchSmartRecruiters, fetchWorkable, fetchWorkday, type BoardResult, type FetchOpts } from "./more.js";

export class BoardNotFoundError extends Error {}

export interface BoardRef {
  vendor: AtsVendor;
  board: string;
  region?: string | null; // 'eu' for Lever's EU instance
}

export function boardUrl(ref: BoardRef): string {
  const b = encodeURIComponent(ref.board);
  switch (ref.vendor) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true&pay_transparency=true`;
    case "lever":
      return `https://api${ref.region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${b}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`;
    default:
      throw new Error(`No public feed adapter for ${ref.vendor}`);
  }
}

/** Every system the catalog can read. Workday and SmartRecruiters also need the stored ids. */
// SmartRecruiters is not fetched: api.smartrecruiters.com's robots.txt closes it to every bot but LinkedIn's.
export const SUPPORTED_VENDORS = ["greenhouse", "lever", "ashby", "workday", "workable", "recruitee", "amazon", "eightfold", "oracle", "teamtailor", "personio", "bamboohr", "rippling", "breezy", "sitemap"] as const;
export const NEEDS_KNOWN = new Set(["workday", "smartrecruiters", "eightfold", "oracle", "bamboohr", "rippling", "breezy", "sitemap"]);

/** Any supported board, in one shape: jobs with details, ids only seen, and whether the list was complete. */
export async function fetchAny(ref: BoardRef, opts: FetchOpts = {}): Promise<BoardResult> {
  // Live fetches honour robots.txt; tests pass their own fetcher.
  opts = { ...opts, fetcher: opts.fetcher ?? politeFetch(fetch) };
  try {
    switch (ref.vendor) {
      case "workday": return await fetchWorkday(ref.board, opts);
      case "smartrecruiters": return await fetchSmartRecruiters(ref.board, opts);
      case "workable": return await fetchWorkable(ref.board, opts);
      case "recruitee": return await fetchRecruitee(ref.board, opts);
      case "amazon": return await fetchAmazon(ref.board, opts);
      case "eightfold": return await fetchEightfold(ref.board, opts);
      case "oracle": return await fetchOracle(ref.board, opts);
      case "teamtailor": return await fetchTeamtailor(ref.board, opts);
      case "personio": return await fetchPersonio(ref.board, opts);
      case "bamboohr": return await fetchBambooHR(ref.board, opts);
      case "rippling": return await fetchRippling(ref.board, opts);
      case "breezy": return await fetchBreezy(ref.board, opts);
      case "sitemap": return await fetchSitemap(ref.board, opts);
      default: return { jobs: await fetchBoard(ref, opts.fetcher), touch: [], complete: true };
    }
  } catch (e) {
    if (e instanceof BoardGoneError) throw new BoardNotFoundError(`${ref.vendor}:${ref.board} not found`);
    throw e;
  }
}

export async function fetchBoard(ref: BoardRef, fetcher: typeof fetch = fetch): Promise<NormalizedJob[]> {
  const res = await fetcher(boardUrl(ref), {
    headers: { accept: "application/json", "user-agent": "MyCareerAgentBot/0.1 (+https://github.com/ayushjainid/my-career-agent)" },
  });
  // A 404 means the board was removed or renamed. Throw rather than return [], so ingestion
  // never mass-closes a company's jobs because of a bad board token.
  if (res.status === 404) throw new BoardNotFoundError(`${ref.vendor}:${ref.board} not found`);
  if (!res.ok) throw new Error(`${ref.vendor}:${ref.board} HTTP ${res.status}`);
  const body: unknown = await res.json();
  switch (ref.vendor) {
    case "greenhouse":
      return parseGreenhouse(body);
    case "lever":
      return parseLever(body);
    case "ashby":
      return parseAshby(body);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function remoteFrom(...hints: Array<string | null | undefined>): RemoteType {
  const h = hints.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(h)) return "hybrid";
  if (/\bremote\b/.test(h)) return "remote";
  if (/on-?site|in[- ]office/.test(h)) return "onsite";
  return "unknown";
}

function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

// ---------------------------------------------------------------------------
export function parseGreenhouse(body: unknown): NormalizedJob[] {
  const jobs = isObj(body) && Array.isArray(body.jobs) ? body.jobs : [];
  return jobs.filter(isObj).flatMap((j): NormalizedJob[] => {
    const id = j.id != null ? String(j.id) : null;
    const title = str(j.title);
    if (!id || !title) return [];
    const { text: description, integrity } = guardedDescription([{ html: str(j.content) }]);
    const location = isObj(j.location) ? str(j.location.name) : null;

    let pay: PayRange | null = null;
    const ranges = Array.isArray(j.pay_input_ranges) ? j.pay_input_ranges.filter(isObj) : [];
    const r = ranges[0];
    if (r) {
      const min = num(r.min_cents);
      const max = num(r.max_cents);
      if (min !== null || max !== null)
        pay = {
          min: min !== null ? min / 100 : null,
          max: max !== null ? max / 100 : null,
          currency: str(r.currency_type),
          period: "year",
          source: "structured",
        };
    }
    pay ??= parsePayFromText(description);

    return [{
      atsVendor: "greenhouse",
      atsJobId: id,
      title,
      locationText: location,
      remoteType: remoteFrom(location, title),
      pay,
      postedAt: toIso(j.first_published) ?? toIso(j.updated_at),
      applyUrl: str(j.absolute_url),
      descriptionText: description,
      integrity,
    }];
  });
}

export function parseLever(body: unknown): NormalizedJob[] {
  const jobs = Array.isArray(body) ? body : [];
  return jobs.filter(isObj).flatMap((j): NormalizedJob[] => {
    const id = str(j.id);
    const title = str(j.text);
    if (!id || !title) return [];
    const cats = isObj(j.categories) ? j.categories : {};
    const lists = Array.isArray(j.lists) ? j.lists.filter(isObj) : [];
    const { text: description, integrity } = guardedDescription([
      { plain: str(j.descriptionPlain) },
      ...lists.flatMap((l) => [{ plain: str(l.text) }, { html: str(l.content) }]),
      { plain: str(j.additionalPlain) },
    ]);

    let pay: PayRange | null = null;
    if (isObj(j.salaryRange)) {
      const interval = String(j.salaryRange.interval ?? "");
      pay = {
        min: num(j.salaryRange.min),
        max: num(j.salaryRange.max),
        currency: str(j.salaryRange.currency),
        period: /hour/.test(interval) ? "hour" : /month/.test(interval) ? "month" : "year",
        source: "structured",
      };
    }
    pay ??= parsePayFromText(description);

    return [{
      atsVendor: "lever",
      atsJobId: id,
      title,
      locationText: str(cats.location),
      remoteType: remoteFrom(str(j.workplaceType)?.replace("on-site", "onsite"), str(cats.location)),
      pay,
      postedAt: toIso(j.createdAt),
      applyUrl: str(j.applyUrl) ?? str(j.hostedUrl),
      descriptionText: description,
      integrity,
    }];
  });
}

export function parseAshby(body: unknown): NormalizedJob[] {
  const jobs = isObj(body) && Array.isArray(body.jobs) ? body.jobs : [];
  return jobs.filter(isObj).flatMap((j): NormalizedJob[] => {
    const title = str(j.title);
    const id = str(j.id) ?? str(j.jobUrl);
    if (!id || !title) return [];
    if (j.isListed === false) return [];
    // Prefer the HTML: the plain rendering has already lost the markup that hides text.
    const html = str(j.descriptionHtml);
    const { text: description, integrity } = guardedDescription([html ? { html } : { plain: str(j.descriptionPlain) }]);

    let pay: PayRange | null = null;
    const comp = isObj(j.compensation) ? j.compensation : null;
    const parts = comp && Array.isArray(comp.summaryComponents) ? comp.summaryComponents.filter(isObj) : [];
    const salary = parts.find((p) => String(p.compensationType ?? "").toLowerCase() === "salary");
    if (salary) {
      const interval = String(salary.interval ?? "").toUpperCase();
      pay = {
        min: num(salary.minValue),
        max: num(salary.maxValue),
        currency: str(salary.currencyCode),
        period: interval.includes("HOUR") ? "hour" : interval.includes("MONTH") ? "month" : "year",
        source: "structured",
      };
    }
    pay ??= parsePayFromText(description);

    const workplace = str(j.workplaceType);
    return [{
      atsVendor: "ashby",
      atsJobId: id,
      title,
      locationText: str(j.location),
      remoteType: j.isRemote === true ? "remote" : remoteFrom(workplace?.replace(/OnSite/i, "onsite"), str(j.location)),
      pay,
      postedAt: toIso(j.publishedAt),
      applyUrl: str(j.applyUrl) ?? str(j.jobUrl),
      descriptionText: description,
      integrity,
    }];
  });
}
