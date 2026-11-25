// Prints extraction precision for every fixture: npx tsx test/report.ts [fixture]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importResume } from "../src/index.js";
import { nodeReaders } from "./readers.js";
import { score } from "./score.js";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const want = Object.fromEntries(["a", "b", "c", "d"].map((k) => [k, JSON.parse(readFileSync(new URL(`./expected/${k}.json`, import.meta.url), "utf8"))]));
const only = process.argv[2];
let C = 0, T = 0;
for (const f of ["a-jake.tex", "a-jake.pdf", "a-classic.docx", "a-classic.pdf", "b-moderncv.tex", "b-moderncv.pdf", "b-twocol.docx", "b-twocol.pdf", "c-header.docx", "c-header.pdf", "d-awesome.tex", "d-left-dates.pdf"]) {
  if (only && !f.startsWith(only)) continue;
  const got = await importResume(f, new Uint8Array(readFileSync(dir + f)), nodeReaders);
  const s = score(got, want[f[0]!]);
  C += s.correct; T += s.total;
  console.log(`${f.padEnd(16)} ${s.correct}/${s.total}  ${((100 * s.correct) / s.total).toFixed(1)}%`);
  for (const m of s.misses) console.log("   - " + m);
  if (only) console.log(JSON.stringify(got, null, 1).slice(0, 6000));
}
console.log(`overall ${C}/${T} ${((100 * C) / T).toFixed(1)}%`);
