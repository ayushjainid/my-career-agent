// Follow-up policy: when a submitted application has gone quiet, offer a short follow-up draft.
// Drafts only, never sent by My Career Agent. At most two per application. A follow-up may only
// restate claims from materials already submitted for that application.
//
// Policy adapted from .claude/commands/outcome.md in ai-job-search (MIT, Copyright (c) 2026
// Mads Lorentzen). See THIRD_PARTY_NOTICES.md.

import { countWords } from "./formFields.js";

export const FOLLOWUP_DEFAULTS = { quietDays: 10, maxFollowups: 2, staleDays: 60, thankYouWithinDays: 2 } as const;

/** States in which nobody owes the user a reply yet (nothing sent) or the story is over. */
const NOT_CHASEABLE = new Set(["queued", "approved", "ready_for_review", "offer", "rejected", "withdrawn", "failed", "skipped"]);

export interface FollowupApp {
  id: string;
  state: string;
  submittedAt: string | null; // ISO
  /** Dated activity: employer replies, interview updates, the user's own follow-ups. */
  events: Array<{ kind: string; at: string }>;
}

export type FollowupAction =
  | { kind: "follow_up"; appId: string; daysQuiet: number; sent: number }
  | { kind: "thank_you"; appId: string; interviewAt: string }
  | { kind: "consider_closing"; appId: string; daysQuiet: number; sent: number };

const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / DAY);
const parse = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * What to offer today. Any dated activity resets the quiet clock (not only follow-ups); only
 * "followup_sent" events count toward the cap. Unparseable dates are skipped, never guessed.
 */
export function followupActions(
  apps: FollowupApp[],
  today: Date = new Date(),
  opts: Partial<typeof FOLLOWUP_DEFAULTS> = {},
): FollowupAction[] {
  const o = { ...FOLLOWUP_DEFAULTS, ...opts };
  const out: FollowupAction[] = [];
  for (const a of apps) {
    if (NOT_CHASEABLE.has(a.state)) continue;
    const submitted = parse(a.submittedAt);
    if (!submitted) continue;
    const dated = a.events.map((e) => ({ ...e, d: parse(e.at) })).filter((e): e is typeof e & { d: Date } => e.d !== null);
    const sent = dated.filter((e) => e.kind === "followup_sent").length;
    const last = dated.reduce((m, e) => (e.d > m ? e.d : m), submitted);
    const quiet = days(today, last);

    const interview = dated.filter((e) => e.kind === "interview_held").sort((x, y) => y.d.getTime() - x.d.getTime())[0];
    if (interview && days(today, interview.d) <= o.thankYouWithinDays && !dated.some((e) => e.kind === "thank_you_sent" && e.d >= interview.d)) {
      out.push({ kind: "thank_you", appId: a.id, interviewAt: interview.at });
      continue;
    }
    if (quiet < o.quietDays) continue;
    if (sent < o.maxFollowups && quiet < o.staleDays) out.push({ kind: "follow_up", appId: a.id, daysQuiet: quiet, sent });
    else out.push({ kind: "consider_closing", appId: a.id, daysQuiet: quiet, sent });
  }
  return out;
}

export interface FollowupDraftInput {
  kind: "follow_up" | "thank_you";
  channel: "email" | "linkedin" | "portal";
  company: string;
  role: string;
  contactName?: string | null;
  /** One sentence lifted from what was already submitted (resume bullet, answer). Never new claims. */
  submittedClaim: string;
  /** All text the employer already received for this application: used to verify submittedClaim. */
  submittedMaterials: string;
  senderName: string;
}

export interface FollowupDraft {
  subject: string | null;
  body: string;
  words: number;
  warnings: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}%$€£.]+/gu, " ").trim();

/** A plain template the user edits. It works without any AI; an AI rewrite must pass the same checks. */
export function draftFollowup(i: FollowupDraftInput): FollowupDraft {
  const warnings: string[] = [];
  if (!norm(i.submittedMaterials).includes(norm(i.submittedClaim)))
    warnings.push("The reminder sentence is not in the materials you submitted. Use only what the employer has already seen.");
  const hello = i.contactName ? `Hi ${i.contactName},` : `Hello ${i.company} team,`;
  const claim = i.submittedClaim.trim().replace(/\s*\.?$/, ".");
  const body =
    i.kind === "thank_you"
      ? [
          hello,
          "",
          `Thank you for taking the time to talk with me about the ${i.role} role. I enjoyed the conversation and I am even more interested in the team's work.`,
          `One thing I'd bring to the team: ${claim}`,
          "Please let me know if there is anything else I can share to help with the next step.",
          "",
          "Best regards,",
          i.senderName,
        ].join("\n")
      : [
          hello,
          "",
          `I applied for the ${i.role} role and wanted to say that I remain very interested in it.`,
          `A quick reminder of what I'd bring: ${claim}`,
          "Could you share where the process stands and what the timeline looks like?",
          "",
          "Thank you for your time,",
          i.senderName,
        ].join("\n");
  const subject = i.channel === "email" ? (i.kind === "thank_you" ? `Thank you: ${i.role}` : `Following up: ${i.role} application`) : null;
  const words = countWords(body);
  const [lo, hi] = i.channel === "linkedin" ? [30, 90] : [60, 120];
  if (words < lo || words > hi) warnings.push(`${words} words; aim for ${lo}-${hi}.`);
  return { subject, body, words, warnings };
}
