// Beta loop B5: when offers are likely to land. Estimates come from the person's own history
// when there is enough of it (two or more processes that reached a stage), otherwise from
// conservative defaults, and every estimate says which basis it used.

export interface TimingApp {
  id: string;
  companyId: string;
  company: string;
  tier: "warmup" | "mid" | "dream" | null;
  state: string;
  submittedAt: string | null;
  /** When each stage was first reached, from the event log. */
  reached: Partial<Record<"screen" | "interview" | "offer", string>>;
}

export interface StageDays { toScreen: number; screenToInterview: number; interviewToOffer: number }
export const DEFAULT_STAGE_DAYS: StageDays = { toScreen: 12, screenToInterview: 10, interviewToOffer: 14 };

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Stage durations from the person's own processes, stage by stage, falling back per stage. */
export function learnStageDays(history: TimingApp[]): { days: StageDays; basis: Record<keyof StageDays, "yours" | "default">; samples: Record<keyof StageDays, number> } {
  const pairs: Record<keyof StageDays, number[]> = { toScreen: [], screenToInterview: [], interviewToOffer: [] };
  for (const a of history) {
    const r = a.reached;
    if (a.submittedAt && r.screen) pairs.toScreen.push(days(a.submittedAt, r.screen));
    if (r.screen && r.interview) pairs.screenToInterview.push(days(r.screen, r.interview));
    if (r.interview && r.offer) pairs.interviewToOffer.push(days(r.interview, r.offer));
  }
  const out = { ...DEFAULT_STAGE_DAYS };
  const basis = { toScreen: "default", screenToInterview: "default", interviewToOffer: "default" } as Record<keyof StageDays, "yours" | "default">;
  const samples = { toScreen: 0, screenToInterview: 0, interviewToOffer: 0 };
  for (const k of Object.keys(pairs) as Array<keyof StageDays>) {
    // Under a day is a stage logged in catch-up, not how long the stage took; over 180 is noise.
    const xs = pairs[k].filter((d) => d >= 1 && d < 180);
    samples[k] = xs.length;
    if (xs.length >= 2) {
      out[k] = Math.round(median(xs));
      basis[k] = "yours";
    }
  }
  return { days: out, basis, samples };
}

export interface OfferEstimate {
  appId: string;
  company: string;
  companyId: string;
  tier: TimingApp["tier"];
  state: string;
  expectedOffer: string; // ISO date
  basis: "yours" | "default" | "mixed";
}

/** Days from submission to an offer, used by the planner to time dream companies. */
export const timeToOfferDays = (d: StageDays) => d.toScreen + d.screenToInterview + d.interviewToOffer;

export function estimateOffers(active: TimingApp[], learned: ReturnType<typeof learnStageDays>, today: Date): OfferEstimate[] {
  const { days: d, basis } = learned;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return active
    .filter((a) => ["submitted", "screen", "interview"].includes(a.state))
    .map((a) => {
      // Remaining stages from the latest one reached, never earlier than tomorrow.
      const from = a.reached.interview ?? a.reached.screen ?? a.submittedAt ?? today.toISOString();
      const remaining = a.state === "interview" ? d.interviewToOffer
        : a.state === "screen" ? d.screenToInterview + d.interviewToOffer
        : timeToOfferDays(d);
      const used = a.state === "interview" ? ["interviewToOffer"] : a.state === "screen" ? ["screenToInterview", "interviewToOffer"] : ["toScreen", "screenToInterview", "interviewToOffer"];
      const kinds = new Set(used.map((k) => basis[k as keyof StageDays]));
      const t = Math.max(Date.parse(from) + remaining * DAY, today.getTime() + DAY);
      const b: OfferEstimate["basis"] = kinds.size > 1 ? "mixed" : ([...kinds][0] as "yours" | "default");
      return { appId: a.id, company: a.company, companyId: a.companyId, tier: a.tier, state: a.state, expectedOffer: iso(t), basis: b };
    })
    .sort((x, y) => x.expectedOffer.localeCompare(y.expectedOffer));
}

/**
 * The window the person is aiming at (their date, or the median expected offer when unset), and
 * how many live processes are expected to land inside it (± 10 days).
 */
export function offerWindow(estimates: OfferEstimate[], chosen: string | null): { start: string | null; end: string | null; inside: number; source: "yours" | "estimated" | "none" } {
  const center = chosen ?? (estimates.length ? estimates[Math.floor(estimates.length / 2)]!.expectedOffer : null);
  if (!center) return { start: null, end: null, inside: 0, source: "none" };
  const c = Date.parse(center);
  const start = new Date(c - 10 * DAY).toISOString().slice(0, 10);
  const end = new Date(c + 10 * DAY).toISOString().slice(0, 10);
  return { start, end, inside: estimates.filter((e) => e.expectedOffer >= start && e.expectedOffer <= end).length, source: chosen ? "yours" : "estimated" };
}
