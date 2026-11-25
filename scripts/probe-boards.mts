// Checks job boards against their live APIs: how many jobs, and one job's fields. No database, no
// secrets. Used to confirm a board address before adding a company, and by discovery.
//   node dist/probe-boards.mjs workday:nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite recruitee:acme
import { fetchAny } from "../apps/api/src/ats/adapters.js";
import type { AtsVendor } from "@my-career-agent/core";

for (const arg of process.argv.slice(2)) {
  const [vendor, ...rest] = arg.split(":");
  const board = rest.join(":");
  const t = Date.now();
  try {
    const r = await fetchAny({ vendor: vendor as AtsVendor, board }, { maxDetails: 3, maxPages: 3 });
    const j = r.jobs[0];
    console.log(JSON.stringify({ board: arg, ok: true, jobs: r.jobs.length, touch: r.touch.length, complete: r.complete, ms: Date.now() - t,
      sample: j && { id: j.atsJobId, title: j.title, location: j.locationText, posted: j.postedAt, apply: j.applyUrl, pay: j.pay, remote: j.remoteType, text: j.descriptionText.slice(0, 160) } }));
  } catch (e) {
    console.log(JSON.stringify({ board: arg, ok: false, error: (e as Error).message, ms: Date.now() - t }));
  }
}
