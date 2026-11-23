// Deploy smoke check (POC loop P0, and the end-to-end smoke run after every later loop).
// Usage: MCA_URL=https://my-career-agent.<you>.workers.dev MCA_TOKEN=... npm run smoke
// Read-only unless MCA_SMOKE_BUILD=1, which also builds today's queue (safe to repeat).

const base = (process.env.MCA_URL ?? "").trim().replace(/\/$/, "");
const token = (process.env.MCA_TOKEN ?? "").trim();
if (!base || !token) {
  console.error("Set MCA_URL and MCA_TOKEN.");
  process.exit(2);
}

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
const get = (path, auth = true) =>
  fetch(`${base}/api${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
const expectStatus = async (res, want) => {
  if (res.status !== want) throw new Error(`HTTP ${res.status}, expected ${want}`);
  return res;
};

await check("health", async () => (await (await expectStatus(await get("/health", false), 200)).json()).version);
await check("rejects missing token", async () => void (await expectStatus(await get("/profile", false), 401)));
await check("rejects a wrong token", async () =>
  void (await expectStatus(await fetch(`${base}/api/profile`, { headers: { authorization: "Bearer not-a-real-token-000000000" } }), 401)));
await check("dev header is off", async () =>
  void (await expectStatus(await fetch(`${base}/api/profile`, { headers: { "x-dev-user": "someone" } }), 401)));
await check("profile", async () => {
  const p = await (await expectStatus(await get("/profile"), 200)).json();
  return `${p.facts.verified}/${p.facts.n} facts verified, ${p.targets.length} targets`;
});
if (process.env.MCA_SMOKE_BUILD === "1") {
  await check("build queue", async () => {
    const r = await expectStatus(await fetch(`${base}/api/queue/build`, { method: "POST", headers: { authorization: `Bearer ${token}` } }), 200);
    const b = await r.json();
    return `${b.queued} queued, ${b.excluded} excluded, ${b.heldBack} held back`;
  });
}
await check("queue", async () => `${(await (await expectStatus(await get("/queue"), 200)).json()).items.length} items`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
