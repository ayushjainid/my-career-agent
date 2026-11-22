// Posting integrity check: removes hidden content from a job posting and reports anything that
// looks like it was planted for an automated reader (prompt injection, invisible text, look-alike
// letters). It advises; it never blocks. The cleaned text is what every later step reads.
//
// Ported from tools/posting_guard.py in ai-job-search (MIT, Copyright (c) 2026 Mads Lorentzen).
// See THIRD_PARTY_NOTICES.md. Behaviour is kept close to the original so its test cases carry over.

const EXCERPT = 120;
const LINE_MAX = 200;

const ZERO_WIDTH = "​‌‍⁠⁡⁢⁣⁤";
const BIDI = "‎‏‪‫‬‭‮⁦⁧⁨⁩";
const BIDI_TAMPER = "‭‮⁦⁧⁨⁩";
const FORMAT = "­  ";
const BOM = "﻿";

const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;
const TAG_CHAR = /[\u{E0000}-\u{E007F}]/u;
// England, Scotland and Wales flags: the only legitimate use of tag characters.
const RGI_TAG_FLAG = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
const VARIATION = /[︀-️\u{E0100}-\u{E01EF}]/gu;
const VARIATION_RUN = /[︀-️\u{E0100}-\u{E01EF}]{2,}/gu;
const INVISIBLE = new Set([...ZERO_WIDTH, ...BIDI, ...FORMAT, BOM]);

const HIDDEN_STYLE = new RegExp(
  String.raw`(?:^|;)\s*(?:display\s*:\s*none` +
    String.raw`|visibility\s*:\s*(?:hidden|collapse)` +
    String.raw`|opacity\s*:\s*0(?![.\d]*[1-9])` +
    String.raw`|font-size\s*:\s*(?:0(?:\.0+)?(?:px|pt|em|rem|%)?(?![\d.])|[012](?:\.\d+)?px(?![\w.%]))` +
    String.raw`|transform\s*:[^;]*\bscale(?:[XYZ]|3d)?\(\s*0(?![.\d]*[1-9])` +
    String.raw`|color\s*:\s*transparent` +
    String.raw`|clip\s*:\s*rect\(\s*0` +
    String.raw`|clip-path\s*:\s*inset\(\s*(?:100%|(?:5\d|[6-9]\d|100)(?:\.\d+)?%\s*\))` +
    String.raw`|(?:(?:margin-)?(?:left|top)|text-indent)\s*:\s*-(?:99\d+|\d{4,})(?:px|em|rem))`,
  "i",
);
const COLLAPSED_BOX = /\b(?:max-)?(?:height|width)\s*:\s*0(?:\.0+)?(?:px|em|rem|%|pt)?(?![\d.])/i;
const CLIPPED = /\boverflow(?:-[xy])?\s*:\s*hidden\b/i;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

const PRESTRIP = /<!DOCTYPE[^>]*>|<\?[^>]*\?>/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const DROP_BLOCKS = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
const VOID = new Set(["br", "img", "input", "meta", "link", "hr", "wbr", "source", "area", "base", "col", "embed", "param", "track"]);
const BLOCK = new Set([
  "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "section", "article",
  "header", "footer", "table", "thead", "tbody", "blockquote", "pre", "dd", "dt", "dl", "nav", "main",
  "aside", "figure", "form", "fieldset", "legend", "address", "hr", "td", "th", "option",
]);
const IMPLIED_END = new Set(["p", "li", "dd", "dt", "tr", "td", "th", "option"]);
const CLOSES_P = new Set([...BLOCK].filter((b) => b !== "br"));
const HTML_HINT = /<\s*(html|body|div|p|ul|li|br|h[1-6]|span|strong)\b/i;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

const JOB_TITLES =
  "engineer|developer|researcher|scientist|architect|specialist|lead|consultant|manager|analyst|intern|trainer|expert|strategist|designer|tester|owner|programmer";
export const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore (all|any|the|previous|prior|above|earlier)\b/i,
  /\b(disregard|forget)( all| any| the| your| my)? (previous|prior|above|earlier|preceding|initial|original|system) (instructions?|prompts?)\b/i,
  /\byou are (?:an?|the) (?:ai(?![\w-])|ai (?:assistant|agent|model|language model)|assistant|llm|language model)\b/i,
  /\bsystem prompt\b/i,
  /\b(do not|don['’]?t|never) (tell|inform) the user\b(?!['’]s)/i,
  /\b(do not|don['’]?t|never) (mention|reveal|disclose) (this|these|that|it|any of this|the (above|following|previous))\b[^.\n]{0,30}\bto the user\b/i,
  /\b(run|execute) the following (command|commands|script|code|shell|instruction|instructions|steps)\b/i,
  new RegExp(String.raw`\bas an ai(?![\w-])(?![\s/&]+(?:[\w&/-]+\s+){0,3}?(?:${JOB_TITLES})s?\b)`, "i"),
  /^\s*(assistant|system|user)\s*:/i,
  /<\|/i,
  /\[INST\]/i,
  /###\s*(system|instruction)/i,
  /\b(curl|wget|ssh|scp)\b/i,
  /(?<!\bwindow)\.env\b/i,
  /settings\.json/i,
  /allowed-tools/i,
  /\btool_use\b|\bfunction_call\b/i,
];

const WORD = /[\p{L}\p{N}\p{M}_]+/gu;
const LATIN = /[A-Za-z]/;
const CONFUSABLE = /[Ѐ-ӿͰ-Ͽ]/;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•",
  middot: "·", colon: ":", semi: ";", lpar: "(", rpar: ")", sol: "/", num: "#", excl: "!",
};

/** Decode HTML entities (named subset plus every numeric form). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const hit = ENTITIES[code.toLowerCase()];
    // Named entities without a trailing ';' only decode for the common ones, as browsers do.
    if (hit === undefined) return m;
    return m.endsWith(";") || ["amp", "lt", "gt", "quot", "nbsp"].includes(code.toLowerCase()) ? hit : m;
  });
}

export interface IntegrityFindings {
  hiddenBlocks: string[];
  invisibleChars: Record<string, number>;
  invisibleFlagged: number;
  invisibleText: string[];
  instructionLike: string[];
  hiddenUrls: string[];
  visibleUrlCount: number;
  homoglyphRuns: string[];
}

export interface IntegrityReport extends IntegrityFindings {
  /** "alarm" = something looks planted; "context" = hidden content removed, nothing suspicious; "clean". */
  level: "alarm" | "context" | "clean" | "no_text";
  verdict: string;
  checker: "pg-1";
}

function fold(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t \f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const isAlpha = (ch: string | undefined) => !!ch && /\p{L}/u.test(ch);

interface TextFindings {
  invisibleChars: Record<string, number>;
  invisibleFlagged: number;
  invisibleText: string[];
}

/** Remove invisible characters; count them, flag the tampering kinds, decode hidden payloads. */
export function cleanText(input: string): [string, TextFindings] {
  const counts: Record<string, number> = {};
  const chars = [...input];
  for (const [key, set] of [["zero_width", ZERO_WIDTH], ["bidi", BIDI], ["format", FORMAT], ["bom", BOM]] as const) {
    const n = chars.filter((c) => set.includes(c)).length;
    if (n) counts[key] = n;
  }
  const hasFlags = input.match(RGI_TAG_FLAG) !== null;
  const unflagged = input.replace(RGI_TAG_FLAG, "");
  const tags = [...unflagged].filter((c) => TAG_CHAR.test(c)).length;
  if (tags) counts.tag = tags;
  const variation = (input.match(VARIATION) ?? []).length;
  if (variation) counts.variation = variation;

  let flagged = 0;
  chars.forEach((ch, i) => {
    if (BIDI_TAMPER.includes(ch)) flagged++;
    else if ((ZERO_WIDTH.includes(ch) || ch === BOM) && isAlpha(chars[i - 1]) && isAlpha(chars[i + 1])) flagged++;
  });

  const invisibleText: string[] = [];
  for (const run of unflagged.match(TAG_RUN) ?? []) {
    const decoded = [...run]
      .map((c) => (c.codePointAt(0) ?? 0) - 0xe0000)
      .filter((n) => n >= 0x20 && n < 0x7f)
      .map((n) => String.fromCharCode(n))
      .join("")
      .trim();
    if (decoded) invisibleText.push(decoded.slice(0, LINE_MAX));
  }
  for (const run of input.match(VARIATION_RUN) ?? []) {
    const bytes = Uint8Array.from([...run].map((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16;
    }));
    const decoded = [...new TextDecoder("utf-8", { fatal: false }).decode(bytes)]
      .filter((c) => /[\p{L}\p{N}\p{P}\p{S}\p{Zs}]/u.test(c) && c !== "�")
      .join("")
      .trim();
    if (decoded) invisibleText.push(decoded.slice(0, LINE_MAX));
  }

  let text = input.replace(VARIATION, "");
  const strip = (s: string) => [...s].filter((c) => !INVISIBLE.has(c) && !TAG_CHAR.test(c)).join("");
  if (hasFlags) {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(RGI_TAG_FLAG)) {
      out += strip(text.slice(last, m.index)) + m[0];
      last = (m.index ?? 0) + m[0].length;
    }
    text = out + strip(text.slice(last));
  } else {
    text = strip(text);
  }
  return [fold(text), { invisibleChars: counts, invisibleFlagged: flagged, invisibleText }];
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[(m[1] ?? "").toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** The style attribute as a browser reads it: entities decoded, CSS comments removed. */
function styleOf(attrs: Record<string, string>): string {
  return decodeEntities(attrs.style ?? "").replace(CSS_COMMENT, "");
}

function isHidden(rawAttrs: string): boolean {
  const attrs = parseAttrs(rawAttrs);
  if ("hidden" in attrs || (attrs["aria-hidden"] ?? "").trim().toLowerCase() === "true") return true;
  const style = styleOf(attrs);
  if (HIDDEN_STYLE.test(style)) return true;
  return COLLAPSED_BOX.test(style) && CLIPPED.test(style);
}

/**
 * Visible text of an HTML posting, plus what was hidden. Walks a stack of element names with
 * HTML5 implied end tags, so a stray closer cannot end a hidden element early. Navigation is
 * kept out of the hidden report. List items are emitted as "- " lines for the section heuristics.
 */
export function cleanHtml(markup: string): [string, { hiddenBlocks: string[]; hiddenText: string }] {
  const hiddenParts: string[] = [];
  const hiddenBlocks: string[] = [];
  const collect = (m: string) => {
    hiddenParts.push(decodeEntities(m.replace(/<!--|-->/g, " ").replace(/<[^>]+>/g, " ")));
    return " ";
  };
  markup = markup.replace(PRESTRIP, " ").replace(COMMENT, collect).replace(DROP_BLOCKS, collect);

  const visible: string[] = [];
  const hiddenBuf: string[] = [];
  const stack: string[] = [];
  let navAt = new Set<number>();
  let hiddenAt: number | null = null;
  let pos = 0;

  const emit = (t: string) => (hiddenAt === null ? visible : hiddenBuf).push(t);
  const flushHidden = () => {
    const block = fold(decodeEntities(hiddenBuf.join("")));
    hiddenBuf.length = 0;
    hiddenAt = null;
    if (block) {
      hiddenBlocks.push(cleanText(block)[0].slice(0, EXCERPT));
      hiddenParts.push(block);
    }
  };
  const popTo = (index: number) => {
    stack.length = index;
    navAt = new Set([...navAt].filter((i) => i < index));
    if (hiddenAt !== null && hiddenAt >= stack.length) flushHidden();
  };
  const lastIndex = (name: string) => stack.lastIndexOf(name);

  for (const m of markup.matchAll(TAG)) {
    emit(markup.slice(pos, m.index));
    pos = (m.index ?? 0) + m[0].length;
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const rawAttrs = m[3] ?? "";
    if (BLOCK.has(name)) emit("\n");
    if (closing) {
      const index = lastIndex(name);
      if (index >= 0) popTo(index);
      continue;
    }
    const attrs = parseAttrs(rawAttrs);
    const isNav = navAt.size > 0 || name === "nav" || (attrs.role ?? "").trim().toLowerCase() === "navigation";
    const hiddenHere = isHidden(rawAttrs);
    if ((hiddenAt !== null || hiddenHere) && !isNav) {
      for (const u of decodeEntities(rawAttrs).match(URL_RE) ?? []) hiddenParts.push(u);
    }
    if (VOID.has(name)) continue;
    if (IMPLIED_END.has(name) && stack[stack.length - 1] === name) popTo(stack.length - 1);
    else if (CLOSES_P.has(name) && stack[stack.length - 1] === "p") popTo(stack.length - 1);
    stack.push(name);
    const idx = stack.length - 1;
    if (isNav) navAt.add(idx);
    if (hiddenAt === null && hiddenHere) hiddenAt = idx;
    if (name === "li") emit("- ");
  }
  emit(markup.slice(pos));
  if (hiddenAt !== null) flushHidden();

  return [fold(decodeEntities(visible.join(""))), { hiddenBlocks, hiddenText: hiddenParts.join("\n") }];
}

function excerpt(line: string, at: number): string {
  if (line.length <= LINE_MAX) return line;
  const lead = Math.floor(LINE_MAX / 3);
  let start = Math.max(0, at - lead);
  const end = Math.min(line.length, start + LINE_MAX);
  start = Math.max(0, end - LINE_MAX);
  return `${start ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function scan(visible: string, hidden: string) {
  const seen = new Set<string>();
  const instructionLike: string[] = [];
  for (const line of [...visible.split("\n"), ...hidden.split("\n")]) {
    const s = line.trim();
    if (!s || seen.has(s)) continue;
    for (const p of INSTRUCTION_PATTERNS) {
      const hit = p.exec(s);
      if (hit) {
        seen.add(s);
        instructionLike.push(excerpt(s, hit.index));
        break;
      }
    }
  }
  const hiddenUrls = [...new Set(hidden.match(URL_RE) ?? [])];
  const homoglyphRuns = [...new Set((`${visible}\n${hidden}`.match(WORD) ?? []).filter((w) => LATIN.test(w) && CONFUSABLE.test(w)))];
  return { instructionLike, hiddenUrls, visibleUrlCount: (visible.match(URL_RE) ?? []).length, homoglyphRuns };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summarise(f: IntegrityFindings, hasText: boolean): Pick<IntegrityReport, "level" | "verdict"> {
  const alarms: string[] = [];
  if (f.instructionLike.length) alarms.push(plural(f.instructionLike.length, "instruction-like line", "instruction-like lines"));
  if (f.invisibleFlagged) alarms.push(plural(f.invisibleFlagged, "invisible character inside words", "invisible characters inside words"));
  if (f.invisibleChars.tag) alarms.push(plural(f.invisibleChars.tag, "tag character (text hidden from the reader)", "tag characters (text hidden from the reader)"));
  if (f.invisibleText.length) alarms.push(plural(f.invisibleText.length, "string spelled in invisible characters", "strings spelled in invisible characters"));
  if (f.homoglyphRuns.length) alarms.push(plural(f.homoglyphRuns.length, "mixed-script word", "mixed-script words"));
  const context: string[] = [];
  if (f.hiddenBlocks.length) context.push(plural(f.hiddenBlocks.length, "hidden block", "hidden blocks"));
  if (f.hiddenUrls.length) context.push(plural(f.hiddenUrls.length, "hidden URL", "hidden URLs"));
  const removed = context.join(" and ");
  if (alarms.length) {
    const line = `${alarms.join(", ")}: review before using this posting`;
    return { level: "alarm", verdict: removed ? `${line} (${removed} removed)` : line };
  }
  if (!hasText) return { level: "no_text", verdict: "no text to evaluate" };
  if (removed) return { level: "context", verdict: `clean (${removed} removed, none instruction-like)` };
  return { level: "clean", verdict: "clean" };
}

/** Run the whole check. mode "auto" treats input as HTML when it looks like markup. */
export function guardPosting(raw: string, mode: "html" | "text" | "auto" = "auto"): { text: string; report: IntegrityReport } {
  // Greenhouse returns entity-escaped HTML ("&lt;p&gt;"); decode once first if so.
  const src = /&lt;\/?[a-z]/i.test(raw) ? decodeEntities(raw) : raw;
  const asHtml = mode === "html" || (mode === "auto" && HTML_HINT.test(src));
  let text = src;
  let hiddenText = "";
  let hiddenBlocks: string[] = [];
  if (asHtml) [text, { hiddenText, hiddenBlocks }] = cleanHtml(src);
  const [cleaned, tf] = cleanText(text);
  // Block boundaries in HTML leave blank lines; the section heuristics want one line per item.
  const visible = asHtml ? cleaned.split("\n").filter((l) => l.trim() !== "").join("\n") : cleaned;
  const [hiddenClean, htf] = cleanText(hiddenText);
  for (const [k, n] of Object.entries(htf.invisibleChars)) tf.invisibleChars[k] = (tf.invisibleChars[k] ?? 0) + n;
  tf.invisibleFlagged += htf.invisibleFlagged;
  tf.invisibleText.push(...htf.invisibleText);
  const findings: IntegrityFindings = {
    hiddenBlocks,
    ...tf,
    ...scan(visible, [hiddenClean, ...tf.invisibleText].join("\n")),
  };
  return { text: visible, report: { ...findings, ...summarise(findings, visible !== ""), checker: "pg-1" } };
}

/** Compact form for storage on the job row (drops empty fields, caps list lengths). */
export function compactIntegrity(r: IntegrityReport): Record<string, unknown> {
  const out: Record<string, unknown> = { level: r.level, verdict: r.verdict, checker: r.checker };
  const lists = { hiddenBlocks: r.hiddenBlocks, instructionLike: r.instructionLike, invisibleText: r.invisibleText, hiddenUrls: r.hiddenUrls, homoglyphRuns: r.homoglyphRuns };
  for (const [k, v] of Object.entries(lists)) if (v.length) out[k] = v.slice(0, 10);
  if (Object.keys(r.invisibleChars).length) out.invisibleChars = r.invisibleChars;
  if (r.invisibleFlagged) out.invisibleFlagged = r.invisibleFlagged;
  return out;
}
