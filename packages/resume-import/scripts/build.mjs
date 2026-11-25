// Builds the browser reader into apps/api/public/vendor: an ES module with pdf.js, mammoth and
// unified-latex split into chunks that load only when needed, plus pdf.js's worker.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../../apps/api/public/vendor");
const require = createRequire(import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { "resume-import": join(here, "../src/browser.ts") },
  outdir: out,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "chrome110", "firefox115", "safari16"],
  minify: true,
  legalComments: "linked",
  chunkNames: "chunk-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
copyFileSync(join(dirname(require.resolve("pdfjs-dist/package.json")), "build/pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
console.log("built", out);
