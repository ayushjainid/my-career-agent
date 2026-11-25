// PDF → lines, with pdf.js (Mozilla). Rebuilds lines from positioned glyph runs, finds a second
// column when there is one, keeps right-aligned pieces (dates, places) apart, reads bold and italic
// from font names, and repairs pdfTeX's legacy font encoding.
import type { ExtractedDoc, Line } from "./types.js";
import { cleanText, decodeCork, isBoldFont, isItalicFont, stripBullet } from "./text.js";

/** The subset of pdf.js this module uses, so the browser build and Node tests can pass their own copy. */
export interface PdfJs {
  getDocument(src: { data: Uint8Array; disableFontFace?: boolean; useSystemFonts?: boolean; verbosity?: number; isEvalSupported?: boolean }): { promise: Promise<PdfDocument> };
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  destroy(): Promise<void>;
}
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getOperatorList(): Promise<unknown>;
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number; fontName?: string }> }>;
  getAnnotations(): Promise<Array<{ url?: string; unsafeUrl?: string; rect?: number[]; subtype?: string }>>;
  commonObjs: { get(id: string): { name?: string; type?: string } };
}

interface Run {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  bold: boolean;
  italic: boolean;
  symbol: boolean;
  link?: string;
}

const SYMBOL_FONT = /symbol|wingding|dingbat|zapf|fontawesome|opensymbol|cmsy/i;

export async function extractPdf(pdfjs: PdfJs, bytes: Uint8Array): Promise<ExtractedDoc> {
  const doc = await pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0, isEvalSupported: false }).promise;
  const warnings: string[] = [];
  const links = new Set<string>();
  const lines: Line[] = [];
  try {
    const meta: { info?: Record<string, unknown> } = await doc.getMetadata().catch(() => ({ info: {} }));
    const producer = `${meta.info?.Producer ?? ""} ${meta.info?.Creator ?? ""}`;
    const pdftex = /pdftex/i.test(producer);
    let chars = 0;
    for (let p = 1; p <= Math.min(doc.numPages, 6); p++) {
      const page = await doc.getPage(p);
      const { width } = page.getViewport({ scale: 1 });
      await page.getOperatorList(); // loads fonts, so their real names (and so bold/italic) are known
      const content = await page.getTextContent();
      const annots = await page.getAnnotations().catch(() => []);
      const linkRects = annots.filter((a) => a.url || a.unsafeUrl).map((a) => ({ url: String(a.url || a.unsafeUrl), r: a.rect ?? [0, 0, 0, 0] }));
      for (const l of linkRects) links.add(l.url);
      const runs: Run[] = [];
      for (const it of content.items) {
        if (typeof it.str !== "string" || !it.transform) continue;
        let fontName = "";
        let fontType = "";
        try { const f = page.commonObjs.get(it.fontName ?? ""); fontName = f?.name ?? ""; fontType = f?.type ?? ""; } catch {}
        // A bullet drawn from a symbol font often has no Unicode mapping: keep it as a bullet.
        if (!it.str.trim()) {
          if (it.str === "" && SYMBOL_FONT.test(fontName) && (it.width ?? 0) > 0) it.str = "•";
          else continue;
        }
        const type3 = fontType === "Type3" || fontName === "Type3" || /^Type3/.test(fontName);
        const raw = pdftex && type3 ? decodeCork(it.str) : it.str;
        const size = Math.hypot(it.transform[2]!, it.transform[3]!) || it.height || 10;
        const x0 = it.transform[4]!, y = it.transform[5]!;
        const x1 = x0 + (it.width ?? 0);
        const link = linkRects.find((l) => x0 + 1 >= l.r[0]! && x1 - 1 <= l.r[2]! && y + 1 >= l.r[1]! && y - 1 <= l.r[3]!)?.url;
        runs.push({ text: raw, x0, x1, y, size, bold: isBoldFont(fontName), italic: isItalicFont(fontName), symbol: SYMBOL_FONT.test(fontName), link });
        chars += raw.length;
      }
      for (const col of splitColumns(runs, width)) lines.push(...toLines(col));
    }
    if (doc.numPages > 6) warnings.push("Only the first 6 pages were read.");
    if (chars < 80) warnings.push("This PDF has almost no text layer; it may be a scanned image. Try the Word or LaTeX file instead.");
  } finally {
    await doc.destroy().catch(() => {});
  }
  markStyledHeadings(lines);
  return { source: "pdf", lines: mergeWrapped(lines), links: [...links], warnings };
}

/**
 * Finds a vertical gutter that separates two text columns. A real column starts its lines at one x;
 * right-aligned dates in a single-column resume don't, so they never count as a column.
 */
function splitColumns(runs: Run[], width: number): Run[][] {
  if (runs.length < 20) return [runs];
  let best: { a: number; b: number } | null = null;
  let start: number | null = null;
  const limit = Math.max(2, Math.round(runs.length * 0.03));
  for (let x = width * 0.15; x <= width * 0.85; x += 2) {
    const crossing = runs.filter((r) => r.x0 < x - 1 && r.x1 > x + 1).length;
    if (crossing <= limit) { if (start === null) start = x; }
    else if (start !== null) { if (!best || x - start > best.b - best.a) best = { a: start, b: x }; start = null; }
  }
  if (start !== null && (!best || width * 0.85 - start > best.b - best.a)) best = { a: start, b: width * 0.85 };
  if (!best || best.b - best.a < 12) return [runs];
  const gutter = (best.a + best.b) / 2;
  const left = runs.filter((r) => r.x0 < gutter);
  const right = runs.filter((r) => r.x0 >= gutter);
  const aligned = (rs: Run[]) => {
    const starts = lineStarts(rs);
    if (starts.length < 5) return false;
    const counts = new Map<number, number>();
    for (const s of starts) counts.set(Math.round(s / 3), (counts.get(Math.round(s / 3)) ?? 0) + 1);
    return Math.max(...counts.values()) / starts.length >= 0.4;
  };
  return aligned(left) && aligned(right) ? [left, right] : [runs];
}
function lineStarts(rs: Run[]): number[] {
  const rows = new Map<number, number>();
  for (const r of rs) { const k = Math.round(r.y); rows.set(k, Math.min(rows.get(k) ?? Infinity, r.x0)); }
  return [...rows.values()];
}

function toLines(runs: Run[]): Line[] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  // Where several lines start text at the same x (a content column beside a date column), a run
  // starting there begins a new part even after a small gap.
  const startCounts = new Map<number, number>();
  const minX = Math.min(...runs.map((r) => r.x0));
  for (const r of runs) { const k = Math.round(r.x0 / 2); startCounts.set(k, (startCounts.get(k) ?? 0) + 1); }
  const isStop = (x: number) => x - minX > 20 && (startCounts.get(Math.round(x / 2)) ?? 0) + (startCounts.get(Math.round(x / 2) - 1) ?? 0) + (startCounts.get(Math.round(x / 2) + 1) ?? 0) >= 4;
  const maxRight = Math.max(...runs.map((r) => r.x1));
  const rows: Run[][] = [];
  for (const r of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - r.y) < Math.max(2, Math.min(row[0]!.size, r.size) * 0.5)) row.push(r);
    else rows.push([r]);
  }
  const out: Line[] = [];
  let prevY: number | null = null;
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    const size = dominant(row.map((r) => [r.size, r.text.length]));
    const parts: string[] = [];
    const partSizes: number[] = [];
    let cur = "";
    let curSize = 0;
    let lastX1: number | null = null;
    for (const r of row) {
      const gap = lastX1 === null ? 0 : r.x0 - lastX1;
      if (lastX1 !== null && (gap > size * 2.2 || (gap > size * 0.3 && isStop(r.x0)))) { parts.push(cur); partSizes.push(curSize); cur = ""; curSize = 0; }
      else if (lastX1 !== null && gap > size * 0.15 && !cur.endsWith(" ") && !r.text.startsWith(" ")) cur += " ";
      cur += r.text;
      if (r.text.trim()) curSize = Math.max(curSize, r.size);
      lastX1 = r.x1;
    }
    parts.push(cur);
    partSizes.push(curSize);
    const first = row[0]!;
    const keep = parts.map((p) => cleanText(p).trim()).map((p, i) => [p, partSizes[i]!] as const).filter(([p]) => p);
    let cleaned = keep.map(([p]) => p);
    let sizes = keep.map(([, z]) => Math.round(z * 10) / 10);
    // A bullet glyph in a symbol font often has no Unicode mapping at all.
    let bullet = first.symbol && first.x1 - first.x0 < size * 0.8 && row.length > 1;
    if (bullet && cleaned[0] && cleaned[0].length <= 2 && row.length > 1 && cleanText(first.text).trim() === cleaned[0]) { cleaned = cleaned.slice(1); sizes = sizes.slice(1); }
    if (bullet && cleaned[0] && cleaned[0].length === 1 && !/\w/.test(cleaned[0])) { cleaned = cleaned.slice(1); sizes = sizes.slice(1); }
    // A bullet glyph set apart from its text (a tab after it) is its own part: drop it.
    if (cleaned.length > 1 && /^[•●○◦▪■□◆►▸‣⁃∙·\-–—*]$/.test(cleaned[0]!)) { cleaned = cleaned.slice(1); sizes = sizes.slice(1); bullet = true; }
    const sb = stripBullet(cleaned[0] ?? "");
    if (sb.bullet && sb.text) { cleaned[0] = sb.text; bullet = true; }
    if (!cleaned.length) continue;
    const textRuns = row.filter((r) => !r.symbol);
    const chars = textRuns.reduce((n, r) => n + r.text.length, 0) || 1;
    const bold = textRuns.reduce((n, r) => n + (r.bold ? r.text.length : 0), 0) / chars > 0.6;
    const italic = textRuns.reduce((n, r) => n + (r.italic ? r.text.length : 0), 0) / chars > 0.6;
    // Where the words start: after the bullet glyph when the bullet is its own run.
    const glyphOnly = row.length > 1 && /^[^\p{L}\p{N}]$/u.test(cleanText(first.text).trim());
    const textStart = (bullet && glyphOnly ? row.find((r, i) => i > 0 && cleanText(r.text).trim()) ?? first : first).x0;
    out.push({
      text: cleaned.join(" "),
      parts: cleaned,
      size: Math.round(size * 10) / 10,
      bold,
      italic,
      bullet,
      heading: false,
      indent: Math.round(textStart),
      gapBefore: prevY === null ? 0 : Math.max(0, (prevY - first.y - size) / size),
      partSizes: sizes,
      full: row[row.length - 1]!.x1 >= maxRight - size * 2.5,
      contact: row.some((r) => r.link) ? linkContact(row) : undefined,
    });
    prevY = first.y;
  }
  return out;
}

/** Text that is itself a link (an icon line in moderncv: "arjun-mehta" → linkedin.com/in/arjun-mehta). */
function linkContact(row: Run[]): Line["contact"] {
  const c: NonNullable<Line["contact"]> = {};
  for (const r of row) {
    const u = r.link ?? "";
    if (/^mailto:/i.test(u)) c.email = u.replace(/^mailto:/i, "");
    else if (/linkedin\.com/i.test(u)) c.linkedin = u;
    else if (/github\.com/i.test(u)) c.github = u;
  }
  return Object.keys(c).length ? c : undefined;
}

function dominant(pairs: Array<[number, number]>): number {
  const w = new Map<number, number>();
  for (const [v, n] of pairs) w.set(Math.round(v * 2) / 2, (w.get(Math.round(v * 2) / 2) ?? 0) + n);
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

/** A short line set larger than the body, or bold and alone, may be a section heading. */
function markStyledHeadings(lines: Line[]): void {
  const body = dominant(lines.map((l) => [l.size, l.text.length]));
  for (const l of lines) {
    const short = l.text.split(/\s+/).length <= 5 && l.parts.length === 1 && !l.bullet;
    const caps = l.text === l.text.toUpperCase() && /[A-Z]{3}/.test(l.text);
    l.heading = short && (l.size >= body * 1.08 || l.bold || caps);
  }
}

/** Joins the wrapped second line of a bullet back onto it. */
function mergeWrapped(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const continues = prev && prev.bullet && !l.bullet && !l.heading && l.parts.length === 1 && Math.abs(l.indent - prev.indent) <= 3 &&
      l.gapBefore < 0.6 && Math.abs(l.size - prev.size) < 0.6 && !/[.!?]$/.test(prev.text) === true;
    const lowerStart = prev && prev.bullet && !l.bullet && /^[a-z0-9(%]/.test(l.text) && l.gapBefore < 0.8 && l.parts.length === 1;
    if (prev && (continues || lowerStart)) {
      prev.text = `${prev.text} ${l.text}`;
      prev.parts = [...prev.parts.slice(0, -1), `${prev.parts[prev.parts.length - 1]} ${l.text}`];
      continue;
    }
    out.push(l);
  }
  return out;
}
