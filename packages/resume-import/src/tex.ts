// LaTeX (.tex) → lines, with unified-latex. Reads the source itself, so the most common resume
// templates (Jake's resume, moderncv, awesome-cv, and anything built on \newcommand entries) give
// exact fields: company, title, place and dates come from the macro's own arguments.
import { getParser } from "@unified-latex/unified-latex-util-parse";
import type * as Ast from "@unified-latex/unified-latex-types";
import type { ContactField, EntryHint, ExtractedDoc, Line } from "./types.js";
import { cleanText, stripBullet } from "./text.js";

type Kind = "awesome" | "moderncv" | "other";

/** Entry macros of well-known templates: which argument holds which field. */
const ENTRY_MACROS: Record<string, { signature: string; fields: Record<Kind | "any", Array<keyof EntryHint | null>> | Array<keyof EntryHint | null> }> = {
  resumeSubheading: { signature: "m m m m", fields: ["org", "location", "title", "dates"] },
  resumeSubSubheading: { signature: "m m", fields: ["title", "dates"] },
  resumeProjectHeading: { signature: "m m", fields: ["title", "dates"] },
  resumeEntry: { signature: "m m m m", fields: ["org", "location", "title", "dates"] },
  cventry: {
    signature: "m m m m m m",
    fields: { moderncv: ["dates", "title", "org", "location", "extra", null], awesome: ["title", "org", "location", "dates", null], other: ["dates", "title", "org", "location", "extra", null], any: [] },
  },
  cvhonor: { signature: "m m m m", fields: ["title", "org", "location", "dates"] },
};
const ACCENTS: Record<string, string> = { "'": "́", "`": "̀", "^": "̂", '"': "̈", "~": "̃", "=": "̄", ".": "̇", u: "̆", v: "̌", H: "̋", c: "̧", k: "̨", r: "̊", d: "̣", b: "̱" };
const SYMBOLS: Record<string, string> = {
  "%": "%", "&": "&", $: "$", "#": "#", _: "_", "{": "{", "}": "}", textbar: "|", textbullet: "•", bullet: "•", cdot: "·", textperiodcentered: "·",
  textendash: "–", textemdash: "—", LaTeX: "LaTeX", TeX: "TeX", ss: "ß", o: "ø", O: "Ø", l: "ł", L: "Ł", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å",
  i: "ı", textasciitilde: "~", textasciicircum: "^", textbackslash: "\\", copyright: "©", textregistered: "®", texttrademark: "™", pounds: "£", euro: "€", EUR: "€",
  textless: "<", textgreater: ">", ldots: "…", dots: "…", textellipsis: "…", sim: "~", times: "×", pm: "±", geq: "≥", leq: "≤", approx: "≈", rightarrow: "→", to: "→",
  quad: " ", qquad: " ", ",": " ", ";": " ", " ": " ", enspace: " ", thinspace: " ", hspace: " ",
};
const STYLE_WRAPPERS = new Set(["textbf", "textit", "emph", "underline", "textsc", "textsf", "texttt", "textrm", "textmd", "textup", "textsl", "uline", "mbox", "hbox", "makebox", "text", "textnormal", "small", "footnotesize", "scriptsize", "large", "Large", "LARGE", "huge", "Huge", "normalsize", "color", "textcolor", "colorbox", "fbox", "raisebox", "faicon"]);
const NO_OUTPUT = new Set(["vspace", "vfill", "medskip", "smallskip", "bigskip", "noindent", "centering", "raggedright", "label", "pagestyle", "thispagestyle", "setlength", "addtolength", "titleformat", "titlespacing", "newpage", "clearpage", "pagebreak", "linebreak", "phantom", "hphantom", "vphantom", "makecvtitle", "makecvheader", "makecvfooter", "maketitle", "titlerule", "hrule", "rule", "includegraphics", "photo", "moderncvstyle", "moderncvcolor", "moderncvtheme", "usepackage", "documentclass", "input", "include", "fontsize", "selectfont", "bfseries", "itshape", "scshape", "mdseries", "normalfont", "sffamily", "rmfamily", "ttfamily", "upshape", "defaultfontfeatures", "setmainfont", "setsansfont", "urlstyle", "pdfgentounicode", "definecolor", "renewcommand", "newcommand", "def", "let", "geometry", "hypersetup", "nopagebreak", "nolinkurl", "footnote", "cvsubsection"]);
const HEADING = new Set(["section", "subsection", "cvsection", "sectiontitle", "resumeSection", "chapter", "part"]);
const CONTACT_MACROS: Record<string, ContactField> = { email: "email", mobile: "phone", phone: "phone", homepage: "website", linkedin: "linkedin", github: "github", position: "headline", title: "headline", extrainfo: "headline", quote: "headline" };

export function extractTex(source: string): ExtractedDoc {
  const warnings: string[] = [];
  const kind: Kind = /\\documentclass(?:\[[^\]]*\])?\{moderncv\}/.test(source) ? "moderncv" : /\\documentclass(?:\[[^\]]*\])?\{awesome-cv\}/.test(source) ? "awesome" : "other";
  if (/\\(?:input|include)\{/.test(source.replace(/%.*$/gm, ""))) warnings.push("This file includes other .tex files; only this one was read. Upload the PDF for the full resume.");

  // Macros the file defines itself: their argument count, so a custom \job{Org}{Title}{Dates} still parses.
  const macros: Record<string, { signature: string }> = {
    href: { signature: "m m" }, url: { signature: "m" }, social: { signature: "o m" }, phone: { signature: "o m" }, name: { signature: "m m" },
    address: { signature: "m m m" }, cvitem: { signature: "o m m" }, cvitemwithcomment: { signature: "o m m m" }, cvlistitem: { signature: "o m" },
    cvdoubleitem: { signature: "m m m m" }, cvlistdoubleitem: { signature: "m m" }, cvskill: { signature: "m m" }, cvskills: { signature: "" },
    hspace: { signature: "s m" }, vspace: { signature: "s m" }, textcolor: { signature: "m m" }, color: { signature: "m" }, raisebox: { signature: "m m" },
    makebox: { signature: "o o m" }, colorbox: { signature: "m m" }, includegraphics: { signature: "o m" }, photo: { signature: "o o m" },
    newcommand: { signature: "s m o o m" }, renewcommand: { signature: "s m o o m" }, setlength: { signature: "m m" }, addtolength: { signature: "m m" },
    titleformat: { signature: "s m o m m m m o" }, titlespacing: { signature: "s m m m m" }, definecolor: { signature: "m m m" },
    usepackage: { signature: "o m" }, documentclass: { signature: "o m" }, pagestyle: { signature: "m" }, faicon: { signature: "m" },
    position: { signature: "m" }, mobile: { signature: "m" }, homepage: { signature: "m" }, linkedin: { signature: "m" }, github: { signature: "m" }, email: { signature: "m" },
    title: { signature: "m" }, quote: { signature: "m" }, extrainfo: { signature: "m" }, fontsize: { signature: "m m" },
  };
  for (const [name, info] of Object.entries(ENTRY_MACROS)) macros[name] = { signature: info.signature };
  // awesome-cv's \cventry has five arguments, the last being the description.
  if (kind === "awesome") macros.cventry = { signature: "m m m m m" };
  const userArity = new Map<string, number>();
  for (const m of source.matchAll(/\\(?:re|provide)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?/g)) {
    const n = Number(m[2] ?? 0);
    userArity.set(m[1]!, n);
    if (!ENTRY_MACROS[m[1]!]) macros[m[1]!] = { signature: Array(n).fill("m").join(" ") };
    else if (n) macros[m[1]!] = { signature: Array(n).fill("m").join(" ") };
  }
  for (const m of source.matchAll(/\\def\\([A-Za-z@]+)((?:#\d)+)/g)) {
    const n = m[2]!.length / 2;
    userArity.set(m[1]!, n);
    macros[m[1]!] = { signature: Array(n).fill("m").join(" ") };
  }

  // moderncv's \address takes one to three groups; give it all three so it never swallows what follows.
  source = source.replace(/\\address\s*\{([^{}]*)\}(?:\s*\{([^{}]*)\})?(?:\s*\{([^{}]*)\})?/g, (_, a, b, c) => `\\address{${a}}{${b ?? ""}}{${c ?? ""}}`);
  const ast = getParser({ macros }).parse(source);
  const doc = findEnv(ast.content, "document");
  const preamble = doc ? ast.content.slice(0, ast.content.indexOf(doc)) : [];
  const out = new Emitter();
  const links = new Set<string>();
  const ctx: Ctx = { kind, out, links, userArity };

  // Header fields in the preamble (moderncv and awesome-cv keep them there).
  for (const n of preamble) if (n.type === "macro") headerMacro(n, ctx);
  walk(doc ? doc.content : ast.content, ctx);
  out.flush();
  const lines = out.lines;
  if (!lines.length) warnings.push("No text was found in this LaTeX file.");
  return { source: "tex", lines, links: [...links], warnings };
}

interface Ctx { kind: Kind; out: Emitter; links: Set<string>; userArity: Map<string, number> }

class Emitter {
  lines: Line[] = [];
  private parts: string[] = [""];
  private bullet = false;
  private bold = 0;
  private total = 0;
  private depth = 0;
  text(s: string, bold = false) { if (!s) return; this.parts[this.parts.length - 1] += s; const n = s.trim().length; this.total += n; if (bold) this.bold += n; }
  sep() { if (this.parts[this.parts.length - 1]!.trim()) this.parts.push(""); }
  startBullet(depth: number) { this.flush(); this.bullet = true; this.depth = depth; }
  flush() {
    const parts = this.parts.map((p) => cleanText(p.replace(/---/g, "—").replace(/--/g, "–")).trim()).filter((p) => p && !/^[|•·,;–—-]$/.test(p));
    if (parts.length) {
      const sb = stripBullet(parts[0]!);
      if (sb.bullet && sb.text) parts[0] = sb.text;
      this.lines.push({ text: parts.join(" "), parts, size: 0, bold: this.total > 0 && this.bold / this.total > 0.6, italic: false, bullet: this.bullet || sb.bullet, heading: false, indent: this.depth, gapBefore: 0 });
    }
    this.parts = [""]; this.bullet = false; this.bold = 0; this.total = 0;
  }
  push(line: Line) { this.flush(); this.lines.push(line); }
}

function findEnv(nodes: Ast.Node[], name: string): Ast.Environment | null {
  for (const n of nodes) {
    if (n.type === "environment" && n.env === name) return n;
  }
  return null;
}

/** Argument i of a macro as nodes (skipping empty optional/star slots when asked). */
function args(m: Ast.Macro): Ast.Node[][] {
  // Missing optional arguments come back as empty slots with no brackets; skip those.
  return (m.args ?? []).filter((a) => a.openMark === "{" || (a.openMark === "" && a.content.length > 0)).map((a) => a.content);
}
function optArg(m: Ast.Macro): string | null {
  const a = (m.args ?? []).find((x) => x.openMark === "[");
  return a ? inline(a.content).trim() : null;
}

/** Renders nodes as one line of plain text. */
export function inline(nodes: Ast.Node[], links?: Set<string>): string {
  let s = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    switch (n.type) {
      case "string": s += n.content; break;
      case "whitespace": s += " "; break;
      case "parbreak": s += " "; break;
      case "group": s += inline(n.content, links); break;
      case "inlinemath": case "displaymath": s += mathText(n.content); break;
      case "comment": break;
      case "verbatim": s += n.content; break;
      case "environment": s += " " + inline(n.content, links) + " "; break;
      case "macro": {
        const [text, consumed] = macroText(n, nodes[i + 1], links);
        s += text;
        if (consumed) i++;
        break;
      }
      default: break;
    }
  }
  return s.replace(/---/g, "—").replace(/--/g, "–").replace(/``|''/g, '"').replace(/~/g, " ");
}

function mathText(nodes: Ast.Node[]): string {
  const t = inline(nodes).trim();
  return { "|": " | ", "\\cdot": " · ", "\\bullet": " • ", "\\sim": "~", "\\diamond": " · " }[t] ?? (t.length <= 3 ? ` ${t} ` : t);
}

/** A macro as inline text. Returns whether it consumed the next sibling (an accent's letter). */
function macroText(m: Ast.Macro, next: Ast.Node | undefined, links?: Set<string>): [string, boolean] {
  const name = m.content;
  if (ACCENTS[name]) {
    const a = m.args?.length ? inline(m.args[m.args.length - 1]!.content) : next?.type === "group" ? inline(next.content) : next?.type === "string" ? next.content : "";
    const consumed = !m.args?.length && !!next && (next.type === "group" || next.type === "string");
    const letter = a.charAt(0) === "\\" ? a.slice(1) : a;
    const rest = next?.type === "string" && !m.args?.length ? next.content.slice(1) : "";
    return [`${(letter.charAt(0) + ACCENTS[name]).normalize("NFC")}${next?.type === "string" ? rest : letter.slice(1)}`, consumed];
  }
  if (name in SYMBOLS) return [SYMBOLS[name]!, false];
  if (name === "\\" || name === "newline" || name === "hfill" || name === "hfil" || name === "cr") return [" ", false];
  if (name === "href") { const [u, t] = args(m); const url = inline(u ?? []).trim(); links?.add(url); return [inline(t ?? [], links), false]; }
  if (name === "url") { const [u] = args(m); const url = inline(u ?? []).trim(); links?.add(url); return [url, false]; }
  if (NO_OUTPUT.has(name)) return ["", false];
  if (STYLE_WRAPPERS.has(name) || m.args?.length) {
    const as = args(m);
    return [as.length ? inline(as[as.length - 1]!, links) : "", false];
  }
  return ["", false];
}

function headerMacro(m: Ast.Macro, ctx: Ctx): boolean {
  const name = m.content;
  const a = args(m).map((x) => inline(x, ctx.links).trim());
  const contact: NonNullable<Line["contact"]> = {};
  if (name === "name" && a.length >= 2) contact.name = `${a[0]} ${a[1]}`.trim();
  else if (name === "address") contact.location = a.filter(Boolean).join(", ");
  else if (name === "social") {
    const kind = (optArg(m) ?? "").toLowerCase();
    const v = a[a.length - 1] ?? "";
    if (kind === "linkedin") contact.linkedin = /linkedin\.com/.test(v) ? v : `linkedin.com/in/${v}`;
    else if (kind === "github") contact.github = /github\.com/.test(v) ? v : `github.com/${v}`;
    else if (kind) contact.website = v;
  } else if (CONTACT_MACROS[name] && a[a.length - 1]) {
    const field = CONTACT_MACROS[name]!;
    const v = a[a.length - 1]!;
    contact[field] = field === "linkedin" && !/linkedin\.com/.test(v) ? `linkedin.com/in/${v}` : field === "github" && !/github\.com/.test(v) ? `github.com/${v}` : v;
  } else return false;
  if (Object.keys(contact).length) ctx.out.push({ text: Object.values(contact).join(" | "), parts: Object.values(contact) as string[], size: 0, bold: false, italic: false, bullet: false, heading: false, indent: 0, gapBefore: 0, contact });
  return true;
}

function walk(nodes: Ast.Node[], ctx: Ctx, depth = 0): void {
  const { out } = ctx;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.type === "string") { out.text(n.content.replace(/---/g, "—").replace(/--/g, "–")); continue; }
    if (n.type === "whitespace") { out.text(" "); continue; }
    if (n.type === "parbreak") { out.flush(); continue; }
    if (n.type === "comment") continue;
    if (n.type === "inlinemath" || n.type === "displaymath") { out.text(mathText(n.content)); continue; }
    if (n.type === "group") { walk(n.content, ctx, depth); continue; }
    if (n.type === "environment") {
      if (/^(itemize|enumerate|description|cvitems|resumeItemList|highlights)$/.test(n.env)) { out.flush(); walk(n.content, ctx, depth + 1); out.flush(); continue; }
      if (/^(center|flushleft|flushright|minipage|multicols|tabular\*?|tabularx|cvsection|cventries|cvhonors|cvskills|cvparagraph|paracol|adjustwidth)$/.test(n.env)) {
        out.flush(); walk(n.content, ctx, depth); out.flush(); continue;
      }
      walk(n.content, ctx, depth);
      continue;
    }
    if (n.type !== "macro") continue;
    const name = n.content;
    if (headerMacro(n, ctx)) continue;
    if (name === "item") {
      out.startBullet(depth);
      const opt = optArg(n);
      if (opt) { out.text(opt, true); out.text(" "); }
      const body = n.args?.[n.args.length - 1]?.content ?? [];
      walk(body, ctx, depth);
      continue;
    }
    if (HEADING.has(name)) {
      const a = args(n);
      out.push({ text: cleanText(inline(a[a.length - 1] ?? [], ctx.links)).trim(), parts: [cleanText(inline(a[a.length - 1] ?? [], ctx.links)).trim()], size: 0, bold: true, italic: false, bullet: false, heading: true, indent: 0, gapBefore: 0 });
      continue;
    }
    const entry = ENTRY_MACROS[name];
    if (entry) {
      const a = args(n).map((x) => cleanText(inline(x, ctx.links)).trim());
      const fields = Array.isArray(entry.fields) ? entry.fields : entry.fields[ctx.kind];
      const hint: EntryHint = {};
      fields.forEach((f, k) => { if (f && a[k]) hint[f] = a[k]; });
      out.push({ text: a.filter(Boolean).join(" | "), parts: a.filter(Boolean), size: 0, bold: false, italic: false, bullet: false, heading: false, indent: depth, gapBefore: 0, entry: hint });
      // moderncv and awesome-cv put the description in the last argument.
      const lastIdx = fields.length - 1;
      if (fields[lastIdx] === null && args(n)[lastIdx]) { walk(args(n)[lastIdx]!, ctx, depth); out.flush(); }
      continue;
    }
    if (name === "cvitem" || name === "cvskill") {
      const a = args(n).map((x) => cleanText(inline(x, ctx.links)).trim());
      out.push({ text: a.filter(Boolean).join(": "), parts: a.filter(Boolean), size: 0, bold: false, italic: false, bullet: false, heading: false, indent: depth, gapBefore: 0 });
      continue;
    }
    if (name === "cvitemwithcomment") {
      const a = args(n).map((x) => cleanText(inline(x, ctx.links)).trim());
      const t = `${a[0]} (${a[1]})${a[2] ? `, ${a[2]}` : ""}`;
      out.push({ text: t, parts: [t], size: 0, bold: false, italic: false, bullet: false, heading: false, indent: depth, gapBefore: 0 });
      continue;
    }
    if (name === "cvlistitem" || name === "resumeItem" || name === "cvlistdoubleitem") {
      for (const x of args(n)) {
        const t = cleanText(inline(x, ctx.links)).trim();
        if (t) out.push({ text: t, parts: [t], size: 0, bold: false, italic: false, bullet: true, heading: false, indent: depth + 1, gapBefore: 0 });
      }
      continue;
    }
    if (name === "cvdoubleitem") {
      const a = args(n).map((x) => cleanText(inline(x, ctx.links)).trim());
      for (const [k, v] of [[a[0], a[1]], [a[2], a[3]]]) if (k || v) out.push({ text: [k, v].filter(Boolean).join(": "), parts: [k, v].filter(Boolean) as string[], size: 0, bold: false, italic: false, bullet: false, heading: false, indent: depth, gapBefore: 0 });
      continue;
    }
    if (name === "\\" || name === "newline" || name === "cr" || name === "par") { out.flush(); continue; }
    if (name === "hfill" || name === "hfil") { out.sep(); continue; }
    if (name === "textbf" || name === "textsc") { const a = args(n); out.text(cleanText(inline(a[a.length - 1] ?? [], ctx.links)), true); continue; }
    // A macro the file defines with several arguments: treat as an entry and let the structurer read it.
    const arity = ctx.userArity.get(name) ?? 0;
    if (arity >= 2 && !/item/i.test(name)) {
      const a = args(n).map((x) => cleanText(inline(x, ctx.links)).trim()).filter(Boolean);
      if (a.length) out.push({ text: a.join(" | "), parts: a, size: 0, bold: false, italic: false, bullet: false, heading: false, indent: depth, gapBefore: 0 });
      continue;
    }
    if (arity === 1 && /item/i.test(name)) {
      const t = cleanText(inline(args(n)[0] ?? [], ctx.links)).trim();
      if (t) out.push({ text: t, parts: [t], size: 0, bold: false, italic: false, bullet: true, heading: false, indent: depth + 1, gapBefore: 0 });
      continue;
    }
    if (/^(?:section|subsection)$/i.test(name)) continue;
    const [text, consumed] = macroText(n, nodes[i + 1], ctx.links);
    if (/^(textbf)$/.test(name)) out.text(text, true); else out.text(text);
    if (consumed) i++;
  }
}
