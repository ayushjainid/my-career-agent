// F4 blacklist + F7 ranking: hard filters first, then expected chance of a response.

import type { Tier } from "./types.js";

export interface CompanyPreference {
  companyId: string;
  tier?: Tier | null;
  blockMode?: "hard" | "soft" | null;
  blockReason?: string | null;
  blockExpiresAt?: string | null; // ISO date
  includeSubsidiaries?: boolean;
}

export interface BlockResult {
  blocked: boolean;
  mode: "hard" | "soft" | null;
  reason: string | null;
}

/**
 * Is this company blocked for applying? Checks the company itself and, when the user chose
 * "include subsidiaries", every parent up the chain. Expired blocks are ignored.
 */
export function blockStatus(
  companyId: string,
  prefs: Map<string, CompanyPreference>,
  parentOf: Map<string, string> = new Map(),
  today: Date = new Date(),
): BlockResult {
  const isActive = (p: CompanyPreference | undefined) =>
    !!p?.blockMode && (!p.blockExpiresAt || Date.parse(p.blockExpiresAt) >= startOfDay(today));

  const own = prefs.get(companyId);
  if (isActive(own)) return { blocked: true, mode: own!.blockMode!, reason: own!.blockReason ?? null };

  const seen = new Set<string>([companyId]);
  let cur = parentOf.get(companyId);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = prefs.get(cur);
    if (isActive(p) && p!.includeSubsidiaries)
      return { blocked: true, mode: p!.blockMode!, reason: p!.blockReason ?? "Parent company blocked" };
    cur = parentOf.get(cur);
  }
  return { blocked: false, mode: null, reason: null };
}

export interface Candidate {
  jobId: string;
  companyId: string;
  fitScore: number; // 0-100 from scoreResume
  referralStrength: number; // 0-1, 0 = no contact
  postedAt: string | null;
  sponsorship: { score: number; passes: boolean } | null; // null when the user needs no sponsorship
  payMax: number | null;
  payCurrency: string | null;
  status: "open" | "closed" | "stale";
}

export interface RankContext {
  prefs: Map<string, CompanyPreference>;
  parentOf?: Map<string, string>;
  /** Applications to each company in the last 60 days. */
  recentApplicationsByCompany: Map<string, number>;
  alreadyApplied: Set<string>; // job ids
  payFloor: { amount: number; currency: string } | null;
  perCompanyCap?: number; // default 2 per 60 days
  today?: Date;
}

export interface RankedCandidate extends Candidate {
  rankScore: number;
  tier: Tier;
}

export interface Excluded {
  jobId: string;
  reason: string;
}

export function freshness(postedAt: string | null, today: Date = new Date()): number {
  if (!postedAt) return 0.7;
  const days = (today.getTime() - Date.parse(postedAt)) / 86_400_000;
  if (!Number.isFinite(days)) return 0.7;
  if (days <= 3) return 1;
  if (days <= 7) return 0.9;
  if (days <= 14) return 0.75;
  if (days <= 30) return 0.5;
  return 0.3;
}

export function rankCandidates(
  candidates: Candidate[],
  ctx: RankContext,
): { ranked: RankedCandidate[]; excluded: Excluded[] } {
  const today = ctx.today ?? new Date();
  const cap = ctx.perCompanyCap ?? 2;
  const ranked: RankedCandidate[] = [];
  const excluded: Excluded[] = [];

  for (const c of candidates) {
    const block = blockStatus(c.companyId, ctx.prefs, ctx.parentOf, today);
    if (block.blocked) {
      excluded.push({ jobId: c.jobId, reason: `Blocked (${block.mode})${block.reason ? `: ${block.reason}` : ""}` });
      continue;
    }
    if (c.status !== "open") {
      excluded.push({ jobId: c.jobId, reason: `Job is ${c.status}` });
      continue;
    }
    if (ctx.alreadyApplied.has(c.jobId)) {
      excluded.push({ jobId: c.jobId, reason: "Already applied" });
      continue;
    }
    if ((ctx.recentApplicationsByCompany.get(c.companyId) ?? 0) >= cap) {
      excluded.push({ jobId: c.jobId, reason: `Company cap reached (${cap} in 60 days)` });
      continue;
    }
    if (c.sponsorship && !c.sponsorship.passes) {
      excluded.push({ jobId: c.jobId, reason: "Below your sponsorship thresholds" });
      continue;
    }
    if (
      ctx.payFloor &&
      c.payMax !== null &&
      c.payCurrency === ctx.payFloor.currency &&
      c.payMax < ctx.payFloor.amount
    ) {
      excluded.push({ jobId: c.jobId, reason: "Top of pay range is below your floor" });
      continue;
    }

    const sponsorFactor = c.sponsorship ? 0.5 + 0.5 * c.sponsorship.score : 1;
    const rankScore =
      (c.fitScore / 100) * (1 + 1.5 * clamp01(c.referralStrength)) * freshness(c.postedAt, today) * sponsorFactor;
    ranked.push({ ...c, rankScore: Math.round(rankScore * 1000) / 1000, tier: ctx.prefs.get(c.companyId)?.tier ?? "mid" });
  }

  ranked.sort((a, b) => b.rankScore - a.rankScore || a.jobId.localeCompare(b.jobId));
  return { ranked, excluded };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
