// "Start setup over": the person picks which parts of their data to clear; the login, access
// tokens, AI key and plan stay. Everything chosen is cleared in one transaction.
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { stmt, type Stmt } from "./lib/tenant.js";

export const accountReset = new Hono<AppBindings>();

/** What can be cleared, and the statements that clear it. Row-level security keeps each to the caller's rows. */
export const RESET_PARTS = {
  facts_resume: [`DELETE FROM mca.fact WHERE source = 'resume'`, `DELETE FROM mca.resume_import`],
  facts_manual: [`DELETE FROM mca.fact WHERE source = 'manual'`],
  answers: [`DELETE FROM mca.answer_bank_entry`],
  languages: [`DELETE FROM mca.user_language`],
  work_auth: [`DELETE FROM mca.work_auth`, `UPDATE mca.app_user SET home_country = NULL, offer_window_start = NULL`],
  targets: [`DELETE FROM mca.target`],
  companies: [`DELETE FROM mca.company_preference`],
  contacts: [`DELETE FROM mca.contact`],
  // Events and saved answers go with each application (ON DELETE CASCADE).
  applications: [`DELETE FROM mca.inbound_email`, `DELETE FROM mca.application`, `DELETE FROM mca.queue_run`],
} as const;
export type ResetPart = keyof typeof RESET_PARTS;

accountReset.get("/account/reset", async (c) => {
  const [[n] = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT
        (SELECT count(*) FROM mca.fact WHERE source = 'resume')::int AS facts_resume,
        (SELECT count(*) FROM mca.fact WHERE source = 'manual')::int AS facts_manual,
        (SELECT count(*) FROM mca.answer_bank_entry)::int AS answers,
        (SELECT count(*) FROM mca.user_language)::int AS languages,
        (SELECT count(*) FROM mca.work_auth)::int AS work_auth,
        (SELECT count(*) FROM mca.target)::int AS targets,
        (SELECT count(*) FROM mca.company_preference)::int AS companies,
        (SELECT count(*) FROM mca.contact)::int AS contacts,
        (SELECT count(*) FROM mca.application WHERE state NOT IN ('queued', 'skipped'))::int AS applications`),
  ]);
  return c.json({ counts: n ?? {} });
});

accountReset.post("/account/reset", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { clear?: unknown };
  const clear = Array.isArray(b.clear) ? [...new Set(b.clear.filter((x): x is string => typeof x === "string"))] : [];
  const unknown = clear.filter((x) => !(x in RESET_PARTS));
  if (unknown.length) return c.json({ error: `Unknown part: ${unknown.join(", ")}` }, 400);
  if (!clear.length) return c.json({ error: "Pick at least one thing to clear." }, 400);
  const stmts: Stmt[] = clear.flatMap((k) => RESET_PARTS[k as ResetPart].map((sql) => stmt(sql)));
  await c.get("db").asUser(c.get("userId"), stmts);
  return c.json({ ok: true, cleared: clear });
});
