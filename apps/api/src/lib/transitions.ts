// Application state machine (gap #1 in the design review). Only these moves are allowed,
// so a retried or crashed session cannot double-submit or jump states.

export type AppState =
  | "queued" | "approved" | "ready_for_review" | "submitted" | "screen" | "interview"
  | "offer" | "rejected" | "withdrawn" | "failed" | "skipped";

const ALLOWED: Record<AppState, AppState[]> = {
  queued: ["approved", "skipped"],
  approved: ["ready_for_review", "submitted", "failed", "skipped"],
  ready_for_review: ["submitted", "failed", "approved", "skipped"],
  failed: ["approved", "skipped"],
  submitted: ["screen", "interview", "rejected", "withdrawn", "offer"],
  screen: ["interview", "rejected", "withdrawn", "offer"],
  interview: ["interview", "offer", "rejected", "withdrawn"],
  offer: ["withdrawn"],
  rejected: [],
  withdrawn: [],
  skipped: ["queued"],
};

export const ALL_STATES = Object.keys(ALLOWED) as AppState[];

export function isAppState(s: unknown): s is AppState {
  return typeof s === "string" && (ALL_STATES as string[]).includes(s);
}

export function canTransition(from: AppState, to: AppState): boolean {
  return ALLOWED[from].includes(to);
}

/** States that count as an active interview process (for the planner's capacity limit). */
export const ACTIVE_PROCESS_STATES: AppState[] = ["screen", "interview", "offer"];
