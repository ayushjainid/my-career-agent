// Application form-field rules: free-text answers ("Tell us about yourself", "Describe a project",
// "Why us?") are measured, never estimated, and every claim has to trace back to the fact bank.
// The writing itself can come from the user, a template, or any AI the user brings; these checks
// are the same whoever wrote it.
//
// Rules adapted from 08-application-forms.md in ai-job-search (MIT, Copyright (c) 2026 Mads
// Lorentzen). See THIRD_PARTY_NOTICES.md.

import type { Fact } from "./types.js";

export type FieldKind = "self_intro" | "project" | "motivation" | "short_answer" | "other";

export interface FieldLimits {
  maxChars?: number;
  maxWords?: number;
  minWords?: number;
}

/** Recommended lengths when the form states none. Self-intro 100-200 words; project 100-150 + ~60 short. */
export const DEFAULT_FIELD_LIMITS: Record<FieldKind, { full: FieldLimits; short?: FieldLimits }> = {
  self_intro: { full: { minWords: 100, maxWords: 200 }, short: { maxWords: 80 } },
  project: { full: { minWords: 100, maxWords: 150 }, short: { maxWords: 60 } },
  motivation: { full: { minWords: 60, maxWords: 150 }, short: { maxWords: 60 } },
  short_answer: { full: { maxWords: 60 } },
  other: { full: {} },
};

/** Words as a reader counts them: runs of letters/digits, keeping inner apostrophes and hyphens. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/**
 * Characters as a web form counts them. HTML maxlength counts UTF-16 code units, so an emoji or
 * some CJK characters count as two. Line breaks count as one (browsers normalise CRLF to LF).
 */
export function countChars(text: string): number {
  return text.replace(/\r\n/g, "\n").length;
}

export interface FieldCheck {
  words: number;
  chars: number;
  ok: boolean;
  problems: string[];
  /** Set when the text is over a hard limit: the form would cut it, often mid-word. */
  overBy?: { chars?: number; words?: number };
}

export function checkField(text: string, limits: FieldLimits): FieldCheck {
  const words = countWords(text);
  const chars = countChars(text);
  const problems: string[] = [];
  const overBy: NonNullable<FieldCheck["overBy"]> = {};
  if (limits.maxChars !== undefined && chars > limits.maxChars) {
    overBy.chars = chars - limits.maxChars;
    problems.push(`${chars} characters; the limit is ${limits.maxChars} (over by ${overBy.chars}). The form would cut it off.`);
  }
  if (limits.maxWords !== undefined && words > limits.maxWords) {
    overBy.words = words - limits.maxWords;
    problems.push(`${words} words; the limit is ${limits.maxWords} (over by ${overBy.words}).`);
  }
  if (limits.minWords !== undefined && words < limits.minWords) problems.push(`${words} words; aim for at least ${limits.minWords}.`);
  if (/\s$/.test(text) || /^\s/.test(text)) problems.push("Leading or trailing whitespace counts toward the limit.");
  return { words, chars, ok: problems.length === 0, problems, ...(Object.keys(overBy).length ? { overBy } : {}) };
}

/**
 * A short variant is needed when the form gives no limit (it may be tighter than it looks once
 * pasted) or when the full answer uses more than 85% of a stated limit.
 */
export function needsShortVariant(text: string, limits: FieldLimits): boolean {
  if (limits.maxChars === undefined && limits.maxWords === undefined) return true;
  const c = limits.maxChars !== undefined && countChars(text) > 0.85 * limits.maxChars;
  const w = limits.maxWords !== undefined && countWords(text) > 0.85 * limits.maxWords;
  return c || w;
}

/** Figures in a claim (numbers, percentages, money, multipliers) normalised for comparison. */
function figures(text: string): string[] {
  return (text.match(/[$€£]?\d[\d,.]*\s?(?:%|x|k|m|bn|percent)?/gi) ?? [])
    .map((f) => f.toLowerCase().replace(/[\s,]/g, "").replace(/percent$/, "%").replace(/\.$/, ""))
    .filter((f) => f.length > 0);
}

export interface GroundingCheck {
  ok: boolean;
  /** Figures in the answer that no cited fact contains. The most common fabrication. */
  unsupportedFigures: string[];
  /** Cited fact ids that do not exist or are not verified. */
  badCitations: string[];
}

/**
 * Every factual claim must trace to a verified fact. Deterministically we can check the part
 * that matters most: every figure in the answer appears in a cited, verified fact.
 */
export function checkGrounding(answer: string, citedFactIds: string[], facts: Fact[]): GroundingCheck {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const badCitations = citedFactIds.filter((id) => !byId.get(id)?.verified);
  const sourceFigures = new Set(
    citedFactIds.flatMap((id) => {
      const f = byId.get(id);
      return f?.verified ? figures(`${f.text} ${f.startDate ?? ""} ${f.endDate ?? ""}`) : [];
    }),
  );
  const unsupportedFigures = [...new Set(figures(answer))].filter((f) => !sourceFigures.has(f));
  return { ok: unsupportedFigures.length === 0 && badCitations.length === 0, unsupportedFigures, badCitations };
}

export interface FieldDraft {
  label: string;
  kind: FieldKind;
  text: string;
  shortText?: string;
  citedFactIds: string[];
  limits?: FieldLimits;
}

export interface FieldReview {
  label: string;
  full: FieldCheck;
  short: FieldCheck | null;
  grounding: GroundingCheck;
  shortVariantMissing: boolean;
  ready: boolean;
}

/** Review one drafted field: measured lengths, short variant present when needed, grounded figures. */
export function reviewField(d: FieldDraft, facts: Fact[]): FieldReview {
  const defaults = DEFAULT_FIELD_LIMITS[d.kind];
  const limits = d.limits && Object.keys(d.limits).length ? d.limits : defaults.full;
  const full = checkField(d.text, limits);
  const shortLimits = d.limits?.maxChars || d.limits?.maxWords ? limits : (defaults.short ?? limits);
  const short = d.shortText !== undefined ? checkField(d.shortText, shortLimits) : null;
  const statedLimit = d.limits?.maxChars !== undefined || d.limits?.maxWords !== undefined;
  const shortVariantMissing = d.kind !== "short_answer" && d.shortText === undefined && needsShortVariant(d.text, statedLimit ? d.limits ?? {} : {});
  const grounding = checkGrounding(`${d.text}\n${d.shortText ?? ""}`, d.citedFactIds, facts);
  // Over a hard limit blocks; a soft length miss or missing short variant is advice only.
  const hardOver = full.overBy !== undefined && statedLimit;
  const ready = !hardOver && grounding.ok && (short === null || short.overBy === undefined);
  return { label: d.label, full, short, grounding, shortVariantMissing, ready };
}
