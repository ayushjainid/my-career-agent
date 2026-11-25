// Hard gates that run before scoring. A FAIL removes a job from the queue (shown in "excluded"
// with the quoted line, never silently dropped); a FLAG keeps it but tells the user why.
//
// The language and eligibility gates follow the design in 04-job-evaluation.md of ai-job-search
// (MIT, Copyright (c) 2026 Mads Lorentzen), made deterministic. See THIRD_PARTY_NOTICES.md.

import { detectLanguage } from "./postingLanguage.js";

export type GateVerdict = "PASS" | "FLAG" | "FAIL";

export interface GateResult {
  gate: "language" | "eligibility";
  verdict: GateVerdict;
  /** One line per finding, quoting the posting. */
  notes: string[];
}

// ---------- Language gate ----------

/** Levels on one ordinal scale. Plain-English words map to their usual CEFR band. */
export const LANGUAGE_LEVELS = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, native: 7 } as const;
export type LanguageLevel = keyof typeof LANGUAGE_LEVELS;

export interface DeclaredLanguage {
  language: string; // English name, any case: "Spanish"
  level: LanguageLevel;
}

const LEVEL_WORDS: Array<[RegExp, number]> = [
  [/\b(native|mother[- ]tongue|first language)\b/i, 7],
  [/\bc2\b|\bbilingual\b|\bnear[- ]native\b/i, 6],
  [/\bc1\b|\bfluen(?:t|cy)\b|\badvanced\b|\bfull professional\b/i, 5],
  [/\bb2\b|\bbusiness(?:[- ]level| proficiency| fluent)?\b|\bprofessional working\b|\bproficien(?:t|cy)\b|\bstrong\b|\bexcellent\b/i, 4],
  [/\bb1\b|\bworking knowledge\b|\bintermediate\b|\bgood\b/i, 3],
  [/\ba2\b|\bconversational\b|\bbasic\b|\belementary\b/i, 2],
  [/\ba1\b|\bbeginner\b/i, 1],
];

// Natural languages only. Ambiguous names that are also tech or everyday words are left out.
const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Russian",
  "Ukrainian", "Czech", "Slovak", "Hungarian", "Romanian", "Bulgarian", "Greek", "Turkish", "Swedish",
  "Norwegian", "Danish", "Finnish", "Icelandic", "Estonian", "Latvian", "Lithuanian", "Croatian",
  "Serbian", "Slovenian", "Arabic", "Hebrew", "Persian", "Farsi", "Hindi", "Urdu", "Bengali", "Tamil",
  "Telugu", "Marathi", "Gujarati", "Punjabi", "Kannada", "Malayalam", "Mandarin", "Cantonese",
  "Chinese", "Japanese", "Korean", "Vietnamese", "Thai", "Indonesian", "Malay", "Tagalog", "Filipino",
  "Swahili", "Catalan", "Basque", "Galician", "Irish", "Welsh",
];
const ALIASES: Record<string, string> = {
  farsi: "persian", filipino: "tagalog", mandarin: "chinese",
  // Italian names, in their masculine and feminine forms ("lingua inglese", "inglese fluente")
  italiano: "italian", italiana: "italian", inglese: "english", francese: "french", tedesco: "german", tedesca: "german",
  spagnolo: "spanish", spagnola: "spanish", portoghese: "portuguese", cinese: "chinese", russo: "russian", russa: "russian",
  arabo: "arabic", araba: "arabic", olandese: "dutch", giapponese: "japanese", polacco: "polish", polacca: "polish", rumeno: "romanian", rumena: "romanian",
};
const canonLang = (s: string) => ALIASES[s.toLowerCase()] ?? s.toLowerCase();
const LANG_ALT = LANGUAGES.join("|");
const IT_LANG_ALT = "italiano|italiana|inglese|francese|tedesco|tedesca|spagnolo|spagnola|portoghese|cinese|russo|russa|arabo|araba|olandese|giapponese|polacco|polacca|rumeno|rumena";

// Italian postings: "ottima conoscenza della lingua inglese", "italiano madrelingua", "inglese fluente (C1)".
const IT_LEVEL_WORDS: Array<[RegExp, number]> = [
  [/madrelingua|lingua madre/i, 7],
  [/\bc2\b|bilingue/i, 6],
  [/\bc1\b|ottim[ao]|eccellente|fluente|avanzat[oa]|padronanza/i, 5],
  [/\bb2\b|buon[ao]|professionale|fluido/i, 4],
  [/\bb1\b|discret[oa]|intermedi[oa]/i, 3],
  [/\ba2\b|\bbase\b|scolastic[oa]|elementare/i, 2],
  [/\ba1\b|principiante/i, 1],
];
const IT_REQUIREMENT = new RegExp(
  String.raw`(?:(?:conoscenza|padronanza|competenza|ottim[ao]|buon[ao]|discret[oa]|fluente|madrelingua|livello)[^.\n;]{0,40}?(?:lingua\s+)?\b(${IT_LANG_ALT})\b)` +
    String.raw`|(?:\b(${IT_LANG_ALT})\b\s*(?:\(|:|-|–)?\s*(?:fluente|madrelingua|ottim[ao]|buon[ao]|avanzat[oa]|livello\s*[ABC][12]|[ABC][12])\b)`,
  "gi",
);
const IT_OPTIONAL = /\b(gradit[oaie]|preferibil(?:e|mente)|costituisce titolo preferenziale|titolo preferenziale|(?:è|e) un plus|plus|apprezzat[oaie]|valutat[oaie] positivamente)\b/i;

// A requirement is a job condition: "fluent in X", "X required", "speak X", "X speakers", "X (C1)".
const REQUIREMENT = new RegExp(
  String.raw`(?:(?:fluen(?:t|cy)|native|proficien(?:t|cy)|business[- ]level|working knowledge|conversational|command|speak(?:s|ing)?|written and spoken|spoken and written|communicate|advanced|intermediate|bilingual)[^.\n;]{0,25}?\b(${LANG_ALT})\b)` +
    String.raw`|(?:\b(${LANG_ALT})\b[^.\n;]{0,30}?(?:required|is a must|mandatory|essential|speakers?|speaking|language skills|fluency|proficiency|\((?:[ABC][12])\)|\b[ABC][12]\b))`,
  "gi",
);
const OPTIONAL = /\b(plus|bonus|nice to have|a plus|advantage|advantageous|preferred|desirable|helpful|beneficial)\b/i;

export interface LanguageRequirement {
  language: string;
  level: number | null; // null = language named, no level stated
  optional: boolean;
  line: string;
}

export function extractLanguageRequirements(text: string): LanguageRequirement[] {
  const out = new Map<string, LanguageRequirement>();
  const keep = (name: string, level: number | null, optional: boolean, line: string) => {
    const prev = out.get(name);
    // Keep the strictest mandatory reading of a language.
    if (!prev || (prev.optional && !optional) || (prev.optional === optional && (level ?? 0) > (prev.level ?? 0)))
      out.set(name, { language: name, level, optional, line: line.slice(0, 200) });
  };
  for (const rawLine of text.split(/\n|(?<=[.;])\s+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const m of line.matchAll(REQUIREMENT)) {
      const name = canonLang(m[1] ?? m[2] ?? "");
      if (!name) continue;
      keep(name, LEVEL_WORDS.find(([re]) => re.test(m[0]))?.[1] ?? null, OPTIONAL.test(line), line);
    }
    for (const m of line.matchAll(IT_REQUIREMENT)) {
      const name = canonLang(m[1] ?? m[2] ?? "");
      if (!name) continue;
      keep(name, IT_LEVEL_WORDS.find(([re]) => re.test(m[0]))?.[1] ?? null, IT_OPTIONAL.test(line), line);
    }
  }
  // A posting written in Italian expects Italian at work, even when it doesn't say so.
  if (!out.has("italian") && detectLanguage(text) === "it")
    out.set("italian", { language: "italian", level: 4, optional: false, line: "The posting is written in Italian." });
  return [...out.values()];
}

/** Language and eligibility wording read once from a posting (at fetch time), the same for every user. */
export interface PostingSignals {
  languages: LanguageRequirement[];
  citizenOnly: string | null;
  prOrCitizen: string | null;
  clearance: string | null;
  protectedCategory: string | null;
}

/** Reads the posting's text once; ranking then only compares these against each user. */
export function postingSignals(text: string): PostingSignals {
  const q = (re: RegExp) => (re.test(text) ? quoteLine(text, re) : null);
  return {
    languages: extractLanguageRequirements(text),
    citizenOnly: q(CITIZEN_ONLY),
    prOrCitizen: q(PR_OR_CITIZEN),
    clearance: q(CLEARANCE),
    protectedCategory: q(PROTECTED_CATEGORY),
  };
}

export function languageGate(posting: string | LanguageRequirement[], declared: DeclaredLanguage[]): GateResult {
  const mine = new Map(declared.map((d) => [canonLang(d.language), LANGUAGE_LEVELS[d.level]]));
  const notes: string[] = [];
  let verdict: GateVerdict = "PASS";
  for (const req of typeof posting === "string" ? extractLanguageRequirements(posting) : posting) {
    if (req.optional) continue;
    const have = mine.get(req.language);
    if (have === undefined) {
      verdict = "FAIL";
      notes.push(`Requires ${req.language}, which is not in your languages: "${req.line}"`);
    } else if (req.level !== null && req.level > have) {
      if (verdict !== "FAIL") verdict = "FLAG";
      const yours = Object.entries(LANGUAGE_LEVELS).find(([, v]) => v === have)?.[0];
      notes.push(`Asks for a higher ${req.language} level than you declared (${yours}): "${req.line}"`);
    }
  }
  return { gate: "language", verdict, notes };
}

// ---------- Eligibility gate ----------

export type WorkAuthStatus = "citizen" | "permanent_resident" | "work_visa" | "needs_sponsorship";

const CITIZEN_ONLY = /\b(?:cittadinanza (?:italiana|europea|ue|comunitaria) (?:richiesta|obbligatoria)|(?:è |e )?richiesta (?:la )?cittadinanza (?:italiana|europea|ue|comunitaria)|must be (?:a |an )?(?:u\.?s\.?|us|united states|uk|british|canadian|irish|italian|eu)\s*citizens?|(?:u\.?s\.?|us|united states|uk|british|canadian)\s*citizenship (?:is )?(?:required|mandatory)|citizens only|requires? (?:u\.?s\.?|us) citizenship)\b/i;
const PR_OR_CITIZEN = /\b(?:green card|permanent residen(?:t|ce|cy)|(?:u\.?s\.?|us) persons?\b|itar|export[- ]controlled|indefinite leave to remain|settled status)\b/i;
const CLEARANCE = /\b(?:security clearance|clearance (?:is )?required|active clearance|ts\/sci|top secret|secret clearance|public trust|polygraph|sc clearance|dv clearance|nv1|nv2|baseline clearance)\b/i;

// Italy: roles reserved for people registered under Law 68/1999 (categorie protette).
const PROTECTED_CATEGORY = /\b(?:categorie protette|categoria protetta|l(?:egge)?\.?\s*68\s*\/\s*(?:19)?99|collocamento mirato|art\.?\s*(?:1|18)\s*(?:della )?l(?:egge)?\.?\s*68)\b/i;

/** The line of the posting that triggered a rule (abbreviations like "U.S." stay intact). */
function quoteLine(text: string, re: RegExp): string {
  const m = new RegExp(re.source, re.flags.replace("g", "")).exec(text);
  if (!m) return "";
  const start = text.lastIndexOf("\n", m.index) + 1;
  const endNl = text.indexOf("\n", m.index + m[0].length);
  const line = text.slice(start, endNl === -1 ? text.length : endNl).trim();
  if (line.length <= 200) return line;
  const from = Math.max(0, m.index - start - 80);
  return `${from ? "\u2026" : ""}${line.slice(from, from + 200).trim()}\u2026`;
}

/**
 * Citizenship, permanent-residency and clearance language against the user's status in the job's
 * country. Clearance is FAIL for non-citizens (it requires citizenship almost everywhere) and FLAG
 * for citizens (they may not hold one). An unknown status yields FLAG, never a silent PASS.
 */
export function eligibilityGate(posting: string | PostingSignals, status: WorkAuthStatus | null): GateResult {
  const s = typeof posting === "string" ? postingSignals(posting) : posting;
  const notes: string[] = [];
  let verdict: GateVerdict = "PASS";
  const bump = (v: GateVerdict) => {
    if (v === "FAIL" || (v === "FLAG" && verdict === "PASS")) verdict = v;
  };
  if (s.citizenOnly !== null) {
    const q = s.citizenOnly;
    if (status === "citizen") notes.push(`Citizens only (you qualify): "${q}"`);
    else {
      bump(status === null ? "FLAG" : "FAIL");
      notes.push(`Citizens only: "${q}"`);
    }
  }
  if (s.prOrCitizen !== null) {
    const q = s.prOrCitizen;
    if (status !== "citizen" && status !== "permanent_resident") {
      bump(status === null ? "FLAG" : "FAIL");
      notes.push(`Requires citizenship or permanent residency: "${q}"`);
    }
  }
  if (s.clearance !== null) {
    const q = s.clearance;
    bump(status === "citizen" ? "FLAG" : status === null ? "FLAG" : "FAIL");
    notes.push(`Security clearance: "${q}"`);
  }
  if (s.protectedCategory !== null) {
    bump("FLAG");
    notes.push(`Reserved for candidates registered under Italian Law 68/1999 (categorie protette): "${s.protectedCategory}"`);
  }
  return { gate: "eligibility", verdict, notes };
}

/** Combine gates: the worst verdict wins. */
export function combineGates(results: GateResult[]): GateVerdict {
  if (results.some((r) => r.verdict === "FAIL")) return "FAIL";
  if (results.some((r) => r.verdict === "FLAG")) return "FLAG";
  return "PASS";
}
