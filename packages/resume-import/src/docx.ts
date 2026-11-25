// Word (.docx) → lines, with mammoth. Reads mammoth's document model rather than its HTML, so
// heading styles, list numbering, bold, italic, font size, tabs and table cells all survive.
// Page headers (where many templates put the name and contact line) are read separately.
import { strFromU8, unzipSync } from "fflate";
import type { ExtractedDoc, Line } from "./types.js";
import { cleanText, stripBullet } from "./text.js";

export interface Mammoth {
  convertToHtml(input: { arrayBuffer?: ArrayBuffer; buffer?: Uint8Array }, options: { transformDocument: (d: DocNode) => DocNode }): Promise<unknown>;
}
interface DocNode {
  type: string;
  children?: DocNode[];
  value?: string;
  styleName?: string | null;
  styleId?: string | null;
  numbering?: { level: string | number; isOrdered: boolean } | null;
  isBold?: boolean;
  isItalic?: boolean;
  fontSize?: number | null;
  href?: string;
  breakType?: string;
}

export async function extractDocx(mammoth: Mammoth, bytes: Uint8Array): Promise<ExtractedDoc> {
  let tree: DocNode | null = null;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // The browser build reads arrayBuffer, the Node build reads buffer.
  await mammoth.convertToHtml({ arrayBuffer: ab, buffer: bytes }, { transformDocument: (d) => { tree = d; return d; } });
  const lines: Line[] = [];
  const links = new Set<string>();
  const warnings: string[] = [];

  lines.push(...headerLines(bytes));
  const walk = (n: DocNode) => {
    if (n.type === "paragraph") { const l = paragraphLine(n, links); if (l) lines.push(...l); return; }
    // Table cells are read cell by cell, left to right: a two-column template's sidebar, then its main column.
    for (const c of n.children ?? []) walk(c);
  };
  if (tree) walk(tree);
  if (!lines.length) warnings.push("This Word file has no readable text.");
  return { source: "docx", lines, links: [...links], warnings };
}

function paragraphLine(p: DocNode, links: Set<string>): Line[] | null {
  // A paragraph may hold soft line breaks; each becomes its own line.
  const segs: Array<Array<{ text: string; bold: boolean; italic: boolean; size: number }>> = [[]];
  const visit = (n: DocNode, style: { bold: boolean; italic: boolean; size: number }) => {
    if (n.type === "text") segs[segs.length - 1]!.push({ text: n.value ?? "", ...style });
    else if (n.type === "tab") segs[segs.length - 1]!.push({ text: "\t", ...style });
    else if (n.type === "break" && (n.breakType ?? "line") === "line") segs.push([]);
    else {
      if (n.type === "hyperlink" && n.href) links.add(n.href);
      const next = n.type === "run" ? { bold: !!n.isBold, italic: !!n.isItalic, size: n.fontSize ?? style.size } : style;
      for (const c of n.children ?? []) visit(c, next);
    }
  };
  for (const c of p.children ?? []) visit(c, { bold: false, italic: false, size: 0 });
  const style = `${p.styleName ?? ""} ${p.styleId ?? ""}`;
  const heading = /heading|title|section/i.test(style) && !/subtitle/i.test(style);
  const listItem = !!p.numbering || /list/i.test(style);
  const level = p.numbering ? Number(p.numbering.level) || 0 : 0;
  const out: Line[] = [];
  for (const seg of segs) {
    const raw = seg.map((s) => s.text).join("");
    if (!raw.trim()) continue;
    const parts = raw.split(/\t+|\s{4,}/).map((s) => cleanText(s).trim()).filter(Boolean);
    if (!parts.length) continue;
    const sb = stripBullet(parts[0]!);
    if (sb.bullet && sb.text) parts[0] = sb.text;
    const chars = seg.reduce((n, s) => n + s.text.trim().length, 0) || 1;
    const share = (f: (s: (typeof seg)[number]) => boolean) => seg.filter(f).reduce((n, s) => n + s.text.trim().length, 0) / chars;
    const sizes = seg.filter((s) => s.size).map((s) => s.size);
    out.push({
      text: parts.join(" "),
      parts,
      size: sizes.length ? Math.max(...sizes) : 0,
      bold: share((s) => s.bold) > 0.6,
      italic: share((s) => s.italic) > 0.6,
      bullet: listItem || sb.bullet,
      heading,
      indent: level,
      gapBefore: 0,
    });
  }
  return out.length ? out : null;
}

/** Text in the page header part(s): word/header1.xml etc. Mammoth skips these. */
function headerLines(bytes: Uint8Array): Line[] {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes, { filter: (f) => /^word\/header\d*\.xml$/.test(f.name) }); } catch { return []; }
  const seen = new Set<string>();
  const out: Line[] = [];
  for (const name of Object.keys(files).sort()) {
    const xml = strFromU8(files[name]!);
    for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
      const text = cleanText(
        (p.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>/g) ?? []).map((t) => (t === "<w:tab/>" ? "\t" : t.replace(/<[^>]+>/g, ""))).join("")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
      ).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, parts: [text], size: 0, bold: /<w:b\/>|<w:b w:val="(?:1|true)"/.test(p), italic: false, bullet: false, heading: false, indent: 0, gapBefore: 0 });
    }
  }
  return out;
}
