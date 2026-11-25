// pdf.js and mammoth as Node loads them, for tests.
import type { Readers } from "../src/index.js";

export const nodeReaders: Readers = {
  pdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as never,
  mammoth: async () => ((await import("mammoth")).default ?? (await import("mammoth"))) as never,
};
