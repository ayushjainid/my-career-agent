import { Hono } from "hono";
import { handleEmail } from "./email.js";
import type { AppBindings, Env } from "./env.js";
import { runIngest } from "./ingest.js";
import { appDb } from "./lib/db.js";
import { neonTenantDb } from "./lib/tenant.js";
import { runQueueForUser } from "./queue.js";
import { api } from "./routes.js";

/** Must match the second cron in wrangler.toml: build every user's queue once a day. */
export const QUEUE_CRON = "5 6 * * *";

async function runAllQueues(env: Env): Promise<void> {
  const sql = appDb(env.DATABASE_URL);
  const users = (await sql`SELECT mca.users_for_queue() AS user_id`) as Array<{ user_id: string }>;
  const db = neonTenantDb(sql);
  const today = new Date();
  for (const { user_id } of users) {
    try {
      const r = await runQueueForUser(db, user_id, today);
      console.log(JSON.stringify({ event: "queue", user: user_id, queued: r?.queue.length ?? 0, excluded: r?.excluded.length ?? 0 }));
    } catch (err) {
      console.error(JSON.stringify({ event: "queue_error", user: user_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export const app = new Hono<AppBindings>();
app.route("/api", api);
// Everything else is the static web app (served from ./public by the assets binding).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === QUEUE_CRON) ctx.waitUntil(runAllQueues(env));
    else ctx.waitUntil(runIngest(env).then(() => undefined));
  },
  // Awaited (not waitUntil) so an unknown recipient can still be rejected during the SMTP session.
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
