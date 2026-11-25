import { Hono } from "hono";
import { handleEmail } from "./email.js";
import type { AppBindings, Env } from "./env.js";
import { mountMcp } from "./mcp.js";
import { api } from "./routes.js";

export const app = new Hono<AppBindings>();
app.route("/api", api);
mountMcp(app);
// Everything else is the static web app (served from ./public by the assets binding).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Job fetching and the daily queue run on GitHub Actions (.github/workflows/jobs.yml):
  // the Workers free plan allows 10 ms of CPU per request, and a large job board needs ~850 ms.
  // Awaited (not waitUntil) so an unknown recipient can still be rejected during the SMTP session.
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
