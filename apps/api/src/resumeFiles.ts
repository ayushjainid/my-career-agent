// Beta loop B2: render a ResumeDoc as DOCX and PDF. Single column, real text (no images, no
// tables, no text boxes), standard fonts: the layout applicant-tracking systems parse best.

import { resumeLines, type ResumeDoc, type ResumeRole } from "@my-career-agent/core";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// ---------- DOCX ----------

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Characters XML 1.0 forbids would corrupt the file; drop them.
const xmlSafe = (s: string) => xmlEscape(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ""));

function run(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  const props = [opts.bold ? "<w:b/>" : "", opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : ""].join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlSafe(text)}</w:t></w:r>`;
}
function para(runs: string, opts: { style?: string; spaceBefore?: number; tabRight?: boolean } = {}): string {
  const ppr = [
    opts.style ? `<w:pStyle w:val="${opts.style}"/>` : "",
    opts.tabRight ? `<w:tabs><w:tab w:val="right" w:pos="9638"/></w:tabs>` : "",
    `<w:spacing w:before="${opts.spaceBefore ?? 0}" w:after="40"/>`,
  ].join("");
  return `<w:p><w:pPr>${ppr}</w:pPr>${runs}</w:p>`;
}

function roleXml(r: ResumeRole): string {
  const head = [r.heading, r.org && !r.heading.toLowerCase().includes(r.org.toLowerCase()) ? r.org : null].filter(Boolean).join(", ");
  return (
    para(run(head, { bold: true }) + (r.dates ? `<w:r><w:tab/></w:r>${run(r.dates)}` : ""), { spaceBefore: 120, tabRight: true }) +
    r.bullets.map((b) => para(run(b), { style: "ListBullet" })).join("")
  );
}

export function resumeDocx(doc: ResumeDoc): Uint8Array {
  const c = doc.contact;
  const body: string[] = [
    para(run(c.name, { bold: true, size: 32 })),
    para(run([c.email, c.phone, c.location, ...c.links].filter(Boolean).join(" | "))),
  ];
  if (doc.headline) body.push(para(run(doc.headline, { size: 24 }), { spaceBefore: 60 }));
  const heading = (t: string) => body.push(para(run(t.toUpperCase(), { bold: true }), { style: "Heading1", spaceBefore: 240 }));
  const roles = (t: string, rows: ResumeRole[]) => {
    if (!rows.length) return;
    heading(t);
    body.push(...rows.map(roleXml));
  };
  const h = doc.headings;
  roles(h.experience, doc.experience);
  roles(h.projects, doc.projects);
  roles(h.education, doc.education);
  if (doc.certifications.length) { heading(h.certifications); body.push(...doc.certifications.map((x) => para(run(x)))); }
  if (doc.skills.length) { heading(h.skills); body.push(para(run(doc.skills.join(", ")))); }
  if (doc.languages.length) { heading(h.languages); body.push(para(run(doc.languages.join(", ")))); }
  if (doc.footer) body.push(para(run(doc.footer, { size: 16 }), { spaceBefore: 360 }));

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlSafe(`${c.name} - Resume`)}</dc:title><dc:creator>${xmlSafe(c.name)}</dc:creator></cp:coreProperties>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`),
    "word/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="808080"/></w:pBdr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="360" w:hanging="240"/></w:pPr></w:style></w:styles>`),
    "word/numbering.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1008" w:right="1008" w:bottom="1008" w:left="1008" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  };
  return zipSync(files, { level: 6 });
}

// ---------- PDF ----------

/**
 * The standard PDF fonts only cover Windows-1252. Fold what they can't draw: accents are kept
 * where 1252 has them, typographic dashes stay (1252 has them), anything else becomes its closest
 * ASCII form or is dropped. The DOCX keeps the original text.
 */
const WIN1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function pdfSafe(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN1252_EXTRA.includes(ch)) out += ch;
    else if (ch === "\t") out += " ";
    else {
      const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      out += /^[\x20-\x7e]+$/.test(folded) ? folded : "";
    }
  }
  return out;
}

const PAGE = { w: 612, h: 792, margin: 50 };

export async function resumePdf(doc: ResumeDoc): Promise<{ bytes: Uint8Array; pages: number; lines: string[] }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${doc.contact.name} - Resume`));
  pdf.setAuthor(pdfSafe(doc.contact.name));
  pdf.setProducer("My Career Agent");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;
  const width = PAGE.w - PAGE.margin * 2;
  const ink = rgb(0.1, 0.1, 0.12);

  const ensure = (h: number) => {
    if (y - h < PAGE.margin) {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - PAGE.margin;
    }
  };
  const wrap = (text: string, font: PDFFont, size: number, max: number): string[] => {
    const words = pdfSafe(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= max || !cur) cur = next;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const write = (text: string, font: PDFFont, size: number, indent = 0, after = 2) => {
    for (const line of wrap(text, font, size, width - indent)) {
      ensure(size + after);
      page.drawText(line, { x: PAGE.margin + indent, y: y - size, size, font, color: ink });
      y -= size + after;
    }
  };
  const heading = (t: string) => {
    ensure(30);
    y -= 10;
    page.drawText(pdfSafe(t.toUpperCase()), { x: PAGE.margin, y: y - 10.5, size: 10.5, font: bold, color: ink });
    y -= 14;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.margin + width, y }, thickness: 0.6, color: rgb(0.55, 0.55, 0.58) });
    y -= 6;
  };
  const role = (r: ResumeRole) => {
    const head = pdfSafe([r.heading, r.org && !r.heading.toLowerCase().includes(r.org.toLowerCase()) ? r.org : null].filter(Boolean).join(", "));
    const dates = r.dates ? pdfSafe(r.dates) : "";
    const dw = dates ? regular.widthOfTextAtSize(dates, 10) : 0;
    const headLines = wrap(head, bold, 10.5, width - dw - 12);
    ensure(16);
    y -= 4;
    headLines.forEach((l, i) => {
      ensure(13);
      page.drawText(l, { x: PAGE.margin, y: y - 10.5, size: 10.5, font: bold, color: ink });
      if (i === 0 && dates) page.drawText(dates, { x: PAGE.margin + width - dw, y: y - 10.5, size: 10, font: regular, color: ink });
      y -= 13;
    });
    for (const b of r.bullets) {
      const parts = wrap(b, regular, 10, width - 14);
      parts.forEach((l, i) => {
        ensure(13);
        if (i === 0) page.drawText("-", { x: PAGE.margin + 2, y: y - 10, size: 10, font: regular, color: ink });
        page.drawText(l, { x: PAGE.margin + 14, y: y - 10, size: 10, font: regular, color: ink });
        y -= 13;
      });
    }
  };

  const c = doc.contact;
  write(c.name, bold, 18, 0, 6);
  write([c.email, c.phone, c.location, ...c.links].filter(Boolean).join(" | "), regular, 10, 0, 4);
  if (doc.headline) write(doc.headline, regular, 11.5, 0, 4);
  const section = (t: string, rows: ResumeRole[]) => { if (rows.length) { heading(t); rows.forEach(role); } };
  const h = doc.headings;
  section(h.experience, doc.experience);
  section(h.projects, doc.projects);
  section(h.education, doc.education);
  if (doc.certifications.length) { heading(h.certifications); doc.certifications.forEach((x) => write(x, regular, 10, 0, 3)); }
  if (doc.skills.length) { heading(h.skills); write(doc.skills.join(", "), regular, 10, 0, 3); }
  if (doc.languages.length) { heading(h.languages); write(doc.languages.join(", "), regular, 10, 0, 3); }
  if (doc.footer) { y -= 12; write(doc.footer, regular, 8, 0, 3); }

  const bytes = await pdf.save();
  return { bytes, pages: pdf.getPageCount(), lines: resumeLines(doc).map(pdfSafe) };
}
