// F9: timing planner. Warm-up and mid-tier companies go first; dream companies are held back
// so their expected offer dates land inside the user's target window.

import type { RankedCandidate } from "./ranking.js";

/** Rough defaults in days from application to offer. Replaced by recruiter answers and real data. */
export const DEFAULT_TIME_TO_OFFER_DAYS = { startup: 21, midsize: 35, enterprise: 49 } as const;

export interface PlanInput {
  ranked: RankedCandidate[];
  today: Date;
  /** First day of the window in which the user wants dream-company offers to land. */
  offerWindowStart: Date;
  dailyTarget: number;
  activeProcesses: number;
  maxActiveProcesses: number;
  timeToOfferDays: (companyId: string) => number;
}

export interface PlanOutput {
  today: RankedCandidate[];
  heldBack: Array<{ jobId: string; companyId: string; releaseOn: string }>;
  effectiveTarget: number;
  note: string | null;
}

const DAY = 86_400_000;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function planToday(input: PlanInput): PlanOutput {
  const free = input.maxActiveProcesses - input.activeProcesses;
  let effectiveTarget = input.dailyTarget;
  let note: string | null = null;
  if (free <= 0) {
    effectiveTarget = 0;
    note = `You have ${input.activeProcesses} active interview processes (limit ${input.maxActiveProcesses}). No new applications today.`;
  } else if (free <= 2) {
    effectiveTarget = Math.ceil(input.dailyTarget / 2);
    note = "Close to your interview limit: today's target is halved.";
  }

  const today: RankedCandidate[] = [];
  const heldBack: PlanOutput["heldBack"] = [];
  const companiesToday = new Set<string>();

  for (const c of input.ranked) {
    if (c.tier === "dream") {
      const releaseOn = new Date(input.offerWindowStart.getTime() - input.timeToOfferDays(c.companyId) * DAY);
      if (releaseOn.getTime() > input.today.getTime()) {
        heldBack.push({ jobId: c.jobId, companyId: c.companyId, releaseOn: isoDate(releaseOn) });
        continue;
      }
    }
    if (today.length >= effectiveTarget) continue;
    if (companiesToday.has(c.companyId)) continue; // at most one application per company per day
    companiesToday.add(c.companyId);
    today.push(c);
  }

  heldBack.sort((a, b) => a.releaseOn.localeCompare(b.releaseOn));
  return { today, heldBack, effectiveTarget, note };
}
