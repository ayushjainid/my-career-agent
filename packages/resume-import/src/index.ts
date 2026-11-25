// Reads a resume file into a structured, reviewable resume.
export * from "./types.js";
export { structure } from "./structure.js";
export { extractPdf, type PdfJs } from "./pdf.js";
export { extractDocx, type Mammoth } from "./docx.js";
export { extractTex } from "./tex.js";
export { extractText } from "./plain.js";
export { findDateRange, parseDate, toIsoEnd, toIsoStart } from "./dates.js";

import { extractDocx, type Mammoth } from "./docx.js";
import { extractPdf, type PdfJs } from "./pdf.js";
import { extractText } from "./plain.js";
import { structure } from "./structure.js";
import { extractTex } from "./tex.js";
import type { ExtractedDoc, ParsedResume, Source } from "./types.js";

export class ImportError extends Error {
  override name = "ImportError";
}

/** Which reader a file needs, from its bytes first and its name second. */
export function detectFormat(name: string, bytes: Uint8Array): Source | "doc" | "unknown" {
  const head = String.fromCharCode(...bytes.slice(0, 8));
  if (head.startsWith("%PDF")) return "pdf";
  if (head.startsWith("PK")) return "docx";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "doc";
  if (/\.tex$/i.test(name)) return "tex";
  const text = new TextDecoder().decode(bytes.slice(0, 4000));
  if (/\\documentclass|\\begin\{document\}/.test(text)) return "tex";
  if (/\.(txt|md)$/i.test(name)) return "text";
  return "unknown";
}

export interface Readers {
  pdfjs: () => Promise<PdfJs>;
  mammoth: () => Promise<Mammoth>;
}

export const MAX_BYTES = 10 * 1024 * 1024;

export async function extract(name: string, bytes: Uint8Array, readers: Readers): Promise<ExtractedDoc> {
  if (bytes.byteLength > MAX_BYTES) throw new ImportError("That file is over 10 MB. Export a smaller PDF, or upload the Word or LaTeX file.");
  const fmt = detectFormat(name, bytes);
  switch (fmt) {
    case "pdf": return extractPdf(await readers.pdfjs(), bytes);
    case "docx": return extractDocx(await readers.mammoth(), bytes);
    case "tex": return extractTex(new TextDecoder().decode(bytes));
    case "text": return extractText(new TextDecoder().decode(bytes));
    case "doc": throw new ImportError("That's an older Word file (.doc). Open it in Word or Google Docs and save it as .docx or PDF, then upload that.");
    default: throw new ImportError("That file type isn't supported. Upload a PDF, a Word file (.docx) or a LaTeX file (.tex).");
  }
}

export async function importResume(name: string, bytes: Uint8Array, readers: Readers): Promise<ParsedResume> {
  return structure(await extract(name, bytes, readers));
}
