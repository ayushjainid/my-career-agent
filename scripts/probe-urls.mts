// Checks career-site endpoints from a GitHub runner: robots.txt verdict for our bot, then (only if
// allowed) one request, printing status, type, size and the start of the body. No secrets, no data
// stored. One request per line, a second apart.
//   node dist/probe-urls.mjs scripts/probe-targets.txt
// Each line: METHOD URL [JSON body]; "#" starts a comment.
import { readFileSync } from "node:fs";
import { robotsAllows, BOT_NAME } from "../apps/api/src/lib/robots.js";

const UA = `${BOT_NAME}/0.1 (+https://github.com/ayushjainid/my-career-agent)`;
const lines = readFileSync(process.argv[2]!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
for (const line of lines) {
  const [method, url, ...body] = line.split(/\s+/);
  const out: Record<string, unknown> = { method, url };
  try {
    out.robots = (await robotsAllows(url!)) ? "allowed" : "DISALLOWED";
    if (out.robots === "allowed") {
      const t = Date.now();
      const r = await fetch(url!, { method, redirect: "follow", headers: { "user-agent": UA, accept: "application/json, text/html;q=0.9, */*;q=0.5",
        ...(body.length ? { "content-type": "application/json" } : {}) }, body: body.length ? body.join(" ") : undefined });
      const text = await r.text();
      Object.assign(out, { status: r.status, type: r.headers.get("content-type"), bytes: text.length, ms: Date.now() - t, final: r.url !== url ? r.url : undefined,
        retryAfter: r.headers.get("retry-after") ?? undefined, jsonld: /"@type"\s*:\s*"JobPosting"/.test(text) || undefined, microdata: /itemtype="https?:\/\/schema\.org\/JobPosting"/i.test(text) || undefined,
        itemprops: [...new Set([...text.matchAll(/itemprop="([a-zA-Z]+)"/g)].map((m) => m[1]))].slice(0, 30),
        head: text.replace(/\s+/g, " ").slice(0, Number(process.env.PROBE_CHARS ?? 400)),
        ld: [...text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!.replace(/\s+/g, " ").slice(0, 2500)).slice(0, 2) });
    }
  } catch (e) { out.error = (e as Error).message; }
  console.log(`PROBE ${JSON.stringify(out)}`);
  await new Promise((r) => setTimeout(r, 1000));
}
