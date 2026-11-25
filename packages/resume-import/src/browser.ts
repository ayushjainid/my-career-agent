// The browser entry: reads a File on the person's device. Nothing is uploaded; pdf.js and mammoth
// load only when a file of their kind is chosen.
import { importResume, structure, extractText, type ParsedResume, type Readers } from "./index.js";

export { ImportError, parseDate, toIsoStart, toIsoEnd } from "./index.js";
export type { ParsedResume } from "./index.js";

const readers: Readers = {
  pdfjs: async () => {
    const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;
    return pdfjs as never;
  },
  mammoth: async () => (await import("./vendor-mammoth.js")).default as never,
};

export async function readResumeFile(file: File): Promise<ParsedResume> {
  return importResume(file.name, new Uint8Array(await file.arrayBuffer()), readers);
}

export function readResumeText(text: string): ParsedResume {
  return structure(extractText(text));
}
