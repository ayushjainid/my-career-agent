// F2: resume-to-role scoring. Pure functions; the same scorer serves manual scoring
// ("paste a job") and the daily pipeline, so results agree everywhere.

import { canonicalizeSkill } from "./skills.js";
import type { Fact, JobRequirements, Profile, ScoreBreakdown, Seniority } from "./types.js";

export const SCORER_VERSION = "det-1";

export interface ScoreWeights {
  mustHave: number;
  niceToHave: number;
  seniority: number;
  years: number;
}

/** Defaults; occupation families can override (credentials weigh more in nursing or law). */
export const DEFAULT_WEIGHTS: ScoreWeights = { mustHave: 0.55, niceToHave: 0.15, seniority: 0.15, years: 0.15 };

const SENIORITY_ORDER: Seniority[] = ["entry", "mid", "senior", "lead", "executive"];

export function seniorityFit(user: Seniority, job: Seniority | null): number {
  if (!job) return 1;
  const gap = Math.abs(SENIORITY_ORDER.indexOf(user) - SENIORITY_ORDER.indexOf(job));
  return [1, 0.6, 0.2][gap] ?? 0;
}

/** Years of experience from verified role facts, merging overlapping periods. */
export function yearsOfExperience(facts: Fact[], today: Date = new Date()): number {
  const spans = facts
    .filter((f) => f.kind === "role" && f.verified && f.startDate)
    .map((f) => [Date.parse(f.startDate as string), f.endDate ? Date.parse(f.endDate) : today.getTime()] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const [s, e] of spans) {
    if (curStart === null) {
      curStart = s;
      curEnd = e;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (curStart !== null) total += curEnd - curStart;
  return total / (365.25 * 24 * 3600 * 1000);
}

/** The user's skills: only verified facts count, so scoring never relies on unconfirmed claims. */
export function profileSkills(facts: Fact[]): Set<string> {
  const out = new Set<string>();
  for (const f of facts) {
    if (!f.verified) continue;
    for (const s of f.skills) out.add(canonicalizeSkill(s));
  }
  return out;
}

function coverage(required: string[], have: Set<string>): { ratio: number; hit: string[]; miss: string[] } {
  const hit: string[] = [];
  const miss: string[] = [];
  for (const r of required) (have.has(r) ? hit : miss).push(r);
  return { ratio: required.length ? hit.length / required.length : 0, hit, miss };
}

export function scoreResume(
  req: JobRequirements,
  profile: Profile,
  opts: { weights?: ScoreWeights; today?: Date } = {},
): ScoreBreakdown {
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  const skills = profileSkills(profile.facts);
  const must = coverage(req.mustHave, skills);
  const nice = coverage(req.niceToHave, skills);
  const redFlags: string[] = [];

  // If the job lists no skills at all we cannot judge fit on skills: score them as neutral.
  const noSkills = req.mustHave.length === 0 && req.niceToHave.length === 0;
  let mustRatio = must.ratio;
  let niceRatio = nice.ratio;
  let weights = { ...w };
  if (noSkills) {
    mustRatio = 0.5;
    niceRatio = 0.5;
    redFlags.push("Few requirements detected in the job text; score is less reliable.");
  } else if (req.mustHave.length === 0) {
    weights = { ...w, niceToHave: w.niceToHave + w.mustHave, mustHave: 0 };
  } else if (req.niceToHave.length === 0) {
    weights = { ...w, mustHave: w.mustHave + w.niceToHave, niceToHave: 0 };
  }

  const sFit = seniorityFit(profile.seniority, req.seniority);
  const years = yearsOfExperience(profile.facts, opts.today);
  const yFit = req.minYears ? Math.min(1, years / req.minYears) : 1;

  if (req.mustHave.length && must.ratio < 0.5) redFlags.push("Fewer than half of the must-have skills are in your verified facts.");
  if (sFit <= 0.2) redFlags.push(`Seniority mismatch: role reads as ${req.seniority}, you are ${profile.seniority}.`);
  if (req.minYears && years < req.minYears * 0.5)
    redFlags.push(`Role asks for ${req.minYears}+ years; your verified roles cover about ${years.toFixed(1)}.`);

  const total =
    weights.mustHave * mustRatio + weights.niceToHave * niceRatio + weights.seniority * sFit + weights.years * yFit;

  return {
    total: Math.round(total * 100),
    mustHaveCoverage: round2(mustRatio),
    niceToHaveCoverage: round2(niceRatio),
    seniorityFit: round2(sFit),
    yearsFit: round2(yFit),
    matched: [...must.hit, ...nice.hit],
    gaps: [...must.miss, ...nice.miss],
    redFlags,
    scorerVersion: SCORER_VERSION,
  };
}

/**
 * Suggestions for closing gaps, limited to the fact bank: a gap is only "fixable" if some
 * verified fact mentions the skill in its text but has not tagged it. Nothing is ever invented.
 */
export function gapSuggestions(gaps: string[], facts: Fact[]): Array<{ skill: string; factId: string | null; note: string }> {
  return gaps.map((skill) => {
    const fact = facts.find((f) => f.verified && f.text.toLowerCase().includes(skill.toLowerCase()));
    return fact
      ? { skill, factId: fact.id, note: `Your fact "${truncate(fact.text, 60)}" mentions ${skill}; tag it and surface it in the resume.` }
      : { skill, factId: null, note: `No verified fact shows ${skill}. Leave it out, or add a fact only if it is true.` };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
