// ATS text-layer check: what an applicant-tracking system will actually read from a resume PDF.
// The PDF is extracted elsewhere (jobs/my_career_agent_jobs/ats_text.py, or any extractor the user has);
// these pure functions judge the extracted text. Nothing here depends on how the PDF was made.
//
// normalizeText and findNonAsciiDateRanges are ported from tools/verify_pdf.py in ai-job-search
// (MIT, Copyright (c) 2026 Mads Lorentzen). See THIRD_PARTY_NOTICES.md.

import { findSkills } from "./skills.js";

const TYPOGRAPHIC_FOLDS: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " ",
};

/** Fold for comparison: NFC, typographic punctuation, whitespace. Never applied to the raw dump. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’“”–— ]/g, (c) => TYPOGRAPHIC_FOLDS[c] ?? c)
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const NON_ASCII_DASHES = "‐‑‒–—―−";
const YEAR = String.raw`(?<!\d)(?:19|20)\d{2}(?!\d)`;
const H = String.raw`[^\S\n]*`;
const NON_ASCII_DATE_RANGE = new RegExp(`${YEAR}${H}[${NON_ASCII_DASHES}]|[${NON_ASCII_DASHES}]${H}${YEAR}`, "g");
const TOKEN_BEFORE = /(\S+)[^\S\n]*$/;
const TOKEN_AFTER = /^[^\S\n]*(\S+)/;
const BARE_NUMBER = /^\d+(?:[.,]\d+)*[kKmM%]?$/;
const BARE_YEAR = /^(?:19|20)\d{2}$/;
const TWO_DIGIT_YEAR = /^\d{2}$/;
const OUTER_PUNCT = ".,;:!?()[]{}\"'";
const CURRENCY = /^\p{Sc}$/u;

function stripOuter(token: string): string {
  let s = 0;
  let e = token.length;
  while (s < e && OUTER_PUNCT.includes(token[s] as string)) s++;
  while (e > s && OUTER_PUNCT.includes(token[e - 1] as string)) e--;
  return token.slice(s, e);
}

function bareNumber(token: string): string | null {
  const core = stripOuter(token);
  if (!BARE_NUMBER.test(core)) return null;
  const groups = core.replace(/[kKmM%]+$/, "").split(/[.,]/);
  if (groups.length > 1 && groups.some((g) => BARE_YEAR.test(g))) return null;
  return core;
}

function currencyAmount(token: string): string | null {
  let core = stripOuter(token);
  const chars = [...core];
  if (chars.length && CURRENCY.test(chars[0] as string)) core = chars.slice(1).join("");
  else if (chars.length && CURRENCY.test(chars[chars.length - 1] as string)) core = chars.slice(0, -1).join("");
  else return null;
  return BARE_NUMBER.test(core) ? core : null;
}

function quantityRange(line: string, dashIndex: number): boolean {
  const before = TOKEN_BEFORE.exec(line.slice(0, dashIndex));
  const after = TOKEN_AFTER.exec(line.slice(dashIndex + 1));
  if (!before?.[1] || !after?.[1]) return false;
  const lm = currencyAmount(before[1]);
  const rm = currencyAmount(after[1]);
  const left = lm ?? bareNumber(before[1]);
  const right = rm ?? bareNumber(after[1]);
  if (lm !== null || rm !== null) return left !== null && right !== null;
  if (left === null || right === null) return false;
  if (BARE_YEAR.test(left) && (BARE_YEAR.test(right) || TWO_DIGIT_YEAR.test(right))) return false;
  return true;
}

/**
 * Every year joined to a non-ASCII dash ("2016–2024", "Mar 2016 — Present"). Some ATS parsers
 * split date ranges only on "-" and drop the dates otherwise. Quantity and money ranges are skipped.
 * Run on the raw text layer, never on normalizeText output.
 */
export function findNonAsciiDateRanges(text: string): Array<{ line: string; dash: string }> {
  const hits: Array<{ line: string; dash: string }> = [];
  for (const m of text.matchAll(NON_ASCII_DATE_RANGE)) {
    const start = m.index ?? 0;
    const dash = [...m[0]].find((c) => NON_ASCII_DASHES.includes(c)) as string;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const endNl = text.indexOf("\n", start + m[0].length);
    const line = text.slice(lineStart, endNl === -1 ? text.length : endNl);
    if (quantityRange(line, start + m[0].indexOf(dash) - lineStart)) continue;
    hits.push({ line: line.split(/\s+/).filter(Boolean).join(" "), dash });
  }
  return hits;
}

export interface TextLayerInput {
  /** Raw extracted text (all pages joined with "\n"). */
  text: string;
  pages: number | null;
  expectedPages?: { min?: number; max?: number };
  /** Below this many normalized characters the PDF is probably an image or broken. Default 400. */
  minChars?: number;
  /** Strings that must survive extraction: name, email, phone, each employer, each school. */
  required?: string[];
  /** Canonical skills the target role asks for (from extractRequirements). */
  keywords?: string[];
}

export interface TextLayerIssue {
  code: "no_text" | "too_short" | "page_count" | "missing_required" | "non_ascii_date" | "no_email" | "no_phone" | "keyword_gap";
  severity: "error" | "warning";
  detail: string;
}

export interface TextLayerReport {
  ok: boolean; // no errors (warnings allowed)
  chars: number;
  issues: TextLayerIssue[];
  keywordCoverage: number | null; // 0-1, null when no keywords given
  checker: "atx-1";
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_CANDIDATE = /\+?\(?\d[\d ().-]{7,}\d/g;
/** A phone number has 9-15 digits and is not a year range like "2018 - 2024". */
const hasPhone = (s: string) =>
  [...s.matchAll(PHONE_CANDIDATE)].some((m) => {
    const digits = m[0].replace(/\D/g, "").length;
    return digits >= 9 && digits <= 15 && !/^(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}$/.test(m[0].trim());
  });

/** Judge an extracted resume text layer. Pure: the same input always gives the same report. */
export function checkTextLayer(input: TextLayerInput): TextLayerReport {
  const issues: TextLayerIssue[] = [];
  const norm = normalizeText(input.text);
  const lower = norm.toLowerCase();
  const minChars = input.minChars ?? 400;

  if (norm.length === 0) {
    issues.push({ code: "no_text", severity: "error", detail: "No selectable text. The ATS will see a blank page (is it a scanned image?)." });
    return { ok: false, chars: 0, issues, keywordCoverage: null, checker: "atx-1" };
  }
  if (norm.length < minChars)
    issues.push({ code: "too_short", severity: "error", detail: `Only ${norm.length} characters extracted (expected at least ${minChars}).` });

  const { min, max } = input.expectedPages ?? {};
  if (input.pages !== null && ((min !== undefined && input.pages < min) || (max !== undefined && input.pages > max)))
    issues.push({ code: "page_count", severity: "warning", detail: `${input.pages} pages; expected ${min ?? 1}-${max ?? "any"}.` });

  for (const req of input.required ?? []) {
    const r = normalizeText(req).toLowerCase();
    if (r && !lower.includes(r)) issues.push({ code: "missing_required", severity: "error", detail: `"${req}" is not in the text layer.` });
  }
  if (!EMAIL.test(norm)) issues.push({ code: "no_email", severity: "error", detail: "No email address found in the text layer." });
  if (!hasPhone(norm)) issues.push({ code: "no_phone", severity: "warning", detail: "No phone number found in the text layer." });

  for (const hit of findNonAsciiDateRanges(input.text))
    issues.push({
      code: "non_ascii_date",
      severity: "warning",
      detail: `Date range uses U+${(hit.dash.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")} instead of "-": ${hit.line}`,
    });

  let keywordCoverage: number | null = null;
  const kws = [...new Set((input.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean))];
  if (kws.length) {
    const found = new Set(findSkills(norm).map((k) => k.toLowerCase()));
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literal = (k: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(k)}(?![\\p{L}\\p{N}])`, "u").test(lower);
    const missing = kws.filter((k) => !found.has(k) && !literal(k));
    keywordCoverage = (kws.length - missing.length) / kws.length;
    if (missing.length)
      issues.push({ code: "keyword_gap", severity: "warning", detail: `Not in the text layer: ${missing.slice(0, 10).join(", ")}` });
  }

  return { ok: !issues.some((i) => i.severity === "error"), chars: norm.length, issues, keywordCoverage, checker: "atx-1" };
}
