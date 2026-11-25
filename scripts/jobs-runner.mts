// Fetches job boards and builds queues. Runs on GitHub Actions (.github/workflows/jobs.yml), not on
// the Worker: the Workers free plan allows 10 ms of CPU per request, and one large board takes ~850 ms.
//
//   node dist/jobs-runner.mjs fetch [--stale-minutes 60]   fetch boards not fetched in that long (0 = all)
//   node dist/jobs-runner.mjs queues [--user <id>]         build today's queue for one user, or everyone
//
// Needs INGEST_DATABASE_URL (catalog role) and DATABASE_URL (app role, row-level security), which
// scripts/db-urls.mjs derives from DATABASE_OWNER_URL.
import type { Env } from "../apps/api/src/env.js";
import { runIngest } from "../apps/api/src/ingest.js";
import { appDb } from "../apps/api/src/lib/db.js";
import { neonTenantDb } from "../apps/api/src/lib/tenant.js";
import { runAllQueues } from "../apps/api/src/queue.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const env = { ...process.env } as unknown as Env;

async function fetchJobs() {
  const stale = Number(flag("stale-minutes") ?? 0);
  const r = await runIngest(env, { limit: 1000, staleAfterMinutes: stale });
  console.log(`Fetched ${r.boards} of ${r.total} job boards: ${r.added} new, ${r.updated} updated, ${r.closed} closed, ${r.stale} stale.`);
  for (const e of r.errors) console.log(`::warning::${e.board}: ${e.error}`);
}

async function queues() {
  const sql = appDb(env.DATABASE_URL);
  const one = flag("user");
  const users = one ? [one] : ((await sql`SELECT mca.users_for_queue() AS user_id`) as Array<{ user_id: string }>).map((u) => u.user_id);
  const results = await runAllQueues(env, neonTenantDb(sql), users);
  // Counts only: user ids stay out of the log.
  const failed = results.filter((r) => r.error);
  console.log(`Built ${results.length - failed.length} of ${results.length} queues; ${results.reduce((n, r) => n + r.queued, 0)} jobs queued in all.`);
  for (const f of failed) console.log(`::warning::A queue failed: ${f.error}`);
  if (failed.length && failed.length === results.length) process.exitCode = 1;
}

if (cmd === "fetch") await fetchJobs();
else if (cmd === "queues") await queues();
else {
  console.error("usage: jobs-runner.mjs fetch [--stale-minutes N] | queues [--user ID]");
  process.exitCode = 2;
}
