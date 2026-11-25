// POC loop P3: the daily queue. One pure function combines every check that already exists
// (posting integrity, language and eligibility gates, blacklist, sponsorship, ranking, timing)
// so it can be validated on fixtures alone before it is wired to the database.

import { combineGates, eligibilityGate, languageGate, type DeclaredLanguage, type GateResult, type PostingSignals, type WorkAuthStatus } from "./gates.js";
import { planToday } from "./planner.js";
import { rankCandidates, type CompanyPreference, type Excluded } from "./ranking.js";
import { scoreResume } from "./scoring.js";
import { permitPayCheck, sponsorshipFor, type CountryEvidence } from "./countries.js";
import type { SponsorThresholds } from "./sponsorship.js";
import type { JobRequirements, Profile, Tier } from "./types.js";

export interface QueueJob {
  jobId: string;
  companyId: string;
  title: string;
  country: string | null;
  descriptionText: string;
  /** Read at fetch time; when present the description text is not needed for ranking. */
  signals?: PostingSignals | null;
  requirements: JobRequirements;
  postedAt: string | null;
  status: "open" | "closed" | "stale";
  payMax: number | null;
  payCurrency: string | null;
  integrityLevel: "alarm" | "context" | "clean" | "no_text" | null;
  /** Public sponsor evidence for this company in the job's country; null when none is known. */
  sponsor: CountryEvidence | null;
}

export interface QueueContact {
  companyId: string;
  messagesCount: number;
  lastMessageAt: string | null;
  connectedOn: string | null;
  lastAskAt: string | null;
}

export interface QueueInput {
  jobs: QueueJob[];
  profile: Profile;
  languages: DeclaredLanguage[];
  /** Countries the person targets (from their target roles). Jobs elsewhere are excluded. */
  targetCountries?: string[];
  /** Status per country, upper-case ISO code. Countries not listed are unknown. */
  workAuth: Record<string, { status: WorkAuthStatus; thresholds: SponsorThresholds }>;
  prefs: Map<string, CompanyPreference>;
  parentOf?: Map<string, string>;
  recentApplicationsByCompany: Map<string, number>;
  alreadyApplied: Set<string>;
  payFloor: { amount: number; currency: string } | null;
  contacts: QueueContact[];
  today: Date;
  dailyTarget: number;
  activeProcesses: number;
  maxActiveProcesses: number;
  offerWindowStart: Date | null;
  timeToOfferDays?: (companyId: string) => number;
  /** Jobs below this fit score are not queued. Default 40. */
  minFit?: number;
}

export interface QueueItem {
  jobId: string;
  companyId: string;
  fitScore: number;
  rankScore: number;
  tier: Tier;
  referralStrength: number;
  /** Things the user should see before applying: gate FLAGs, integrity alarms. */
  flags: string[];
  gates: GateResult[];
}

export interface QueueResult {
  queue: QueueItem[];
  heldBack: Array<{ jobId: string; companyId: string; releaseOn: string }>;
  excluded: Excluded[];
  note: string | null;
  builderVersion: "q-1";
}

const DAY = 86_400_000;

/**
 * How strong a referral path one contact gives, 0-1. Deterministic and explainable: a real
 * conversation counts most, recency next, a long connection a little. Recently asked = weaker.
 */
export function contactStrength(c: QueueContact, today: Date): number {
  const days = (iso: string | null) => (iso ? (today.getTime() - Date.parse(iso)) / DAY : Infinity);
  let s = 0.2; // a first-degree connection at the company
  if (c.messagesCount > 0) s += 0.3 + Math.min(0.2, c.messagesCount * 0.02);
  if (days(c.lastMessageAt) <= 365) s += 0.2;
  if (days(c.connectedOn) >= 3 * 365) s += 0.1;
  if (days(c.lastAskAt) <= 90) s -= 0.3; // don't lean on the same person twice in a quarter
  return Math.max(0, Math.min(1, Math.round(s * 100) / 100));
}

export function buildDailyQueue(input: QueueInput): QueueResult {
  const minFit = input.minFit ?? 40;
  const excluded: Excluded[] = [];
  const gatesByJob = new Map<string, GateResult[]>();
  const flagsByJob = new Map<string, string[]>();
  const fitByJob = new Map<string, number>();

  const strengthByCompany = new Map<string, number>();
  for (const c of input.contacts) {
    const s = contactStrength(c, input.today);
    strengthByCompany.set(c.companyId, Math.max(strengthByCompany.get(c.companyId) ?? 0, s));
  }

  const candidates = [];
  const targets = new Set((input.targetCountries ?? []).map((c) => c.toUpperCase()));
  for (const j of input.jobs) {
    const country = (j.country ?? "").toUpperCase();
    if (country && targets.size && !targets.has(country)) {
      excluded.push({ jobId: j.jobId, reason: `Located in ${country}; your target roles are in ${[...targets].join(", ")}` });
      continue;
    }
    const auth = country ? input.workAuth[country] : undefined;
    const gates = [
      languageGate(j.signals ? j.signals.languages : j.descriptionText, input.languages),
      eligibilityGate(j.signals ?? j.descriptionText, auth?.status ?? null),
    ];
    const verdict = combineGates(gates);
    if (verdict === "FAIL") {
      excluded.push({ jobId: j.jobId, reason: gates.flatMap((g) => (g.verdict === "FAIL" ? g.notes : [])).join(" ") || "Failed a gate" });
      continue;
    }
    const flags = gates.flatMap((g) => (g.verdict === "FLAG" ? g.notes : []));
    if (j.integrityLevel === "alarm") flags.push("The posting contains hidden or instruction-like text. Review it before applying.");

    const fit = scoreResume(j.requirements, input.profile).total;
    if (fit < minFit) {
      excluded.push({ jobId: j.jobId, reason: `Fit ${fit} is below ${minFit}` });
      continue;
    }
    gatesByJob.set(j.jobId, gates);
    flagsByJob.set(j.jobId, flags);
    fitByJob.set(j.jobId, fit);

    const needsSponsor = auth?.status === "needs_sponsorship";
    const sponsorship = needsSponsor ? sponsorshipFor(country, j.sponsor, auth.thresholds, j.requirements.sponsorshipSignal, input.today) : null;
    // Ireland and Italy set a minimum salary for the permit: say so when the posted pay can't reach it.
    if (needsSponsor) {
      const pay = permitPayCheck(country, { min: null, max: j.payMax, currency: j.payCurrency, period: "year" });
      if (pay.status === "below" && pay.minimum)
        flags.push(`Posted pay tops out under the ${pay.minimum.permit} minimum of €${pay.minimum.annual.toLocaleString("en-IE")} a year.`);
    }

    candidates.push({
      jobId: j.jobId,
      companyId: j.companyId,
      fitScore: fit,
      referralStrength: strengthByCompany.get(j.companyId) ?? 0,
      postedAt: j.postedAt,
      sponsorship: sponsorship ? { score: sponsorship.score, passes: sponsorship.passes } : null,
      payMax: j.payMax,
      payCurrency: j.payCurrency,
      status: j.status,
    });
  }

  const ranked = rankCandidates(candidates, {
    prefs: input.prefs,
    parentOf: input.parentOf,
    recentApplicationsByCompany: input.recentApplicationsByCompany,
    alreadyApplied: input.alreadyApplied,
    payFloor: input.payFloor,
    today: input.today,
  });
  excluded.push(...ranked.excluded);

  // No offer window set: nothing is held back (dream companies compete like the rest).
  const plan = planToday({
    ranked: ranked.ranked,
    today: input.today,
    offerWindowStart: input.offerWindowStart ?? input.today,
    dailyTarget: input.dailyTarget,
    activeProcesses: input.activeProcesses,
    maxActiveProcesses: input.maxActiveProcesses,
    timeToOfferDays: input.timeToOfferDays ?? (() => 35),
  });
  const heldBack = input.offerWindowStart ? plan.heldBack : [];

  return {
    queue: plan.today.map((r) => ({
      jobId: r.jobId,
      companyId: r.companyId,
      fitScore: fitByJob.get(r.jobId) ?? r.fitScore,
      rankScore: r.rankScore,
      tier: r.tier,
      referralStrength: r.referralStrength,
      flags: flagsByJob.get(r.jobId) ?? [],
      gates: gatesByJob.get(r.jobId) ?? [],
    })),
    heldBack,
    excluded,
    note: plan.note,
    builderVersion: "q-1",
  };
}
