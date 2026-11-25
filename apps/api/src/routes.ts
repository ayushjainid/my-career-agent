// HTTP API. The same operations back the web app, the copy-assist panel and the MCP connector,
// so every client sees one contract.

import {
  combineGates,
  compactIntegrity,
  eligibilityGate,
  extractRequirements,
  gapSuggestions,
  guardPosting,
  languageGate,
  scoreResume,
  type Fact,
  type LanguageLevel,
  type WorkAuthStatus,
  type Profile,
  type Seniority,
} from "@my-career-agent/core";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppBindings } from "./env.js";
import { appDb } from "./lib/db.js";
import { neonTenantDb, stmt } from "./lib/tenant.js";
import { account, authPublic, resolveUser } from "./auth.js";
import { packets } from "./packets.js";
import { profile } from "./profile.js";
import { referrals } from "./referrals.js";
import { resume } from "./resume.js";
import { resumeImport } from "./resumeImport.js";
import { accountReset } from "./accountReset.js";
import { followups } from "./followupsApi.js";
import { gmail, gmailPublic } from "./gmail.js";
import { ai } from "./ai.js";
import { timing } from "./timingApi.js";
import { billing, stripeWebhook } from "./billing.js";
import { canTransition, isAppState, type AppState } from "./lib/transitions.js";

export const api = new Hono<AppBindings>();

/** Constant-time string comparison, so a token cannot be guessed one character at a time. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Resolves "Authorization: Bearer <token>" against API_TOKENS ("userId:token,..."). */
export function userForToken(header: string | undefined, tokens: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m?.[1] || !tokens) return null;
  let found: string | null = null;
  for (const pair of tokens.split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const user = pair.slice(0, i).trim();
    const token = pair.slice(i + 1).trim();
    if (token.length >= 24 && safeEqual(token, m[1]) && !found) found = user;
  }
  return found;
}

/** Every /api request gets the database seam; tests swap in an in-process Postgres. */
const withDb: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("db", c.env.TEST_DB ?? neonTenantDb(appDb(c.env.DATABASE_URL)));
  await next();
};

/**
 * Authentication: a session cookie (people), a personal access token (agents and the MCP
 * connector), or a configured POC API token. DEV_MODE also accepts an explicit user header for
 * local work; it must never be true in a deployed Worker.
 *
 * Cookie-authenticated writes must come from this site's own pages: browsers send Origin on
 * every cross-site write, so a mismatched or cross-site request is refused (CSRF).
 */
export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const r = await resolveUser(c.env, c.get("db"), c.req.header("cookie"), c.req.header("authorization"), (h) =>
    userForToken(h, c.env.API_TOKENS) ?? (c.env.DEV_MODE === "true" ? (c.req.header("x-dev-user") ?? null) : null),
  );
  if (!r) return c.json({ error: "unauthenticated" }, 401);
  if (r.via === "session" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if ((origin && origin !== new URL(c.req.url).origin) || (site && !["same-origin", "none"].includes(site)))
      return c.json({ error: "cross-site request refused" }, 403);
  }
  c.set("userId", r.userId);
  c.set("authVia", r.via);
  if (r.sessionHash) c.set("sessionHash", r.sessionHash);
  await next();
};

api.get("/health", (c) => c.json({ ok: true, service: "my-career-agent-api", version: "0.2.0" }));

api.use("/*", withDb);
api.route("/", authPublic);
api.route("/", stripeWebhook);
api.route("/", gmailPublic);
api.use("/*", requireUser);
api.route("/", account);
api.route("/", profile);
api.route("/", referrals);
api.route("/", packets);
api.route("/", resume);
api.route("/", resumeImport);
api.route("/", accountReset);
api.route("/", followups);
api.route("/", gmail);
api.route("/", ai);
api.route("/", timing);
api.route("/", billing);

const SENIORITIES: Seniority[] = ["entry", "mid", "senior", "lead", "executive"];

/** F2 manual scoring: paste a job (title + text) and get a breakdown against your verified facts. */
api.post("/score", async (c) => {
  const body = await c.req
    .json<{ title?: string; description?: string; seniority?: string; country?: string }>()
    .catch(() => ({}));
  const title = (body as { title?: string }).title?.trim();
  const description = (body as { description?: string }).description?.trim();
  if (!title || !description) return c.json({ error: "title and description are required" }, 400);
  if (description.length > 60_000) return c.json({ error: "description too long" }, 413);

  const country = ((body as { country?: string }).country ?? "").toUpperCase().slice(0, 2);
  const [rows = [], langRows = [], auth = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT id, kind, text, skills, start_date::text AS start_date, end_date::text AS end_date, verified
          FROM mca.fact ORDER BY created_at`),
    stmt(`SELECT language, level FROM mca.user_language`),
    stmt(`SELECT status FROM mca.work_auth WHERE country = $1`, country),
  ]);
  const langs = langRows.map((l) => ({ language: String(l.language), level: l.level as LanguageLevel }));
  const facts: Fact[] = rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as Fact["kind"],
    text: String(r.text),
    skills: (r.skills as string[]) ?? [],
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    verified: Boolean(r.verified),
  }));
  const requested = (body as { seniority?: string }).seniority as Seniority | undefined;
  const profile: Profile = { facts, seniority: requested && SENIORITIES.includes(requested) ? requested : "mid" };

  // Pasted text is untrusted like any posting: strip hidden content first, score only what is visible.
  const { text, report: integrity } = guardPosting(description, "auto");
  const requirements = extractRequirements(title, text);
  const score = scoreResume(requirements, profile);
  const gates = [languageGate(text, langs), eligibilityGate(text, country ? ((auth[0]?.status as WorkAuthStatus | undefined) ?? null) : null)];
  return c.json({
    requirements,
    score,
    suggestions: gapSuggestions(score.gaps.slice(0, 5), facts),
    integrity: compactIntegrity(integrity),
    gates,
    gateVerdict: combineGates(gates),
  });
});

/** State changes go through the state machine and are logged to the append-only event table. */
api.post("/applications/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "bad application id" }, 400);
  const body = await c.req.json<{ state?: string; note?: string }>().catch(() => ({}) as { state?: string; note?: string });
  if (!isAppState(body.state)) return c.json({ error: "invalid state" }, 400);
  const to: AppState = body.state;
  const userId = c.get("userId");
  const db = c.get("db");
  const [rows = []] = await db.asUser(userId, [stmt(`SELECT state FROM mca.application WHERE id = $1`, id)]);
  const from = rows[0]?.state as AppState | undefined;
  if (!from) return c.json({ error: "application not found" }, 404);
  if (from === to) return c.json({ ok: true, state: to, unchanged: true });
  if (!canTransition(from, to)) return c.json({ error: `cannot move from ${from} to ${to}` }, 409);

  // One statement: the guarded UPDATE and its event row land together or not at all. A concurrent
  // change makes the UPDATE match nothing, so no event is written and the caller gets 409.
  const [changed = []] = await db.asUser(userId, [
    stmt(`WITH u AS (
            UPDATE mca.application SET state = $2,
              submitted_at = CASE WHEN $2::text = 'submitted' THEN now() ELSE submitted_at END
            WHERE id = $1 AND state = $3 RETURNING id)
          INSERT INTO mca.application_event (user_id, application_id, kind, payload)
          SELECT $4, u.id, 'state_change', $5::jsonb FROM u RETURNING application_id`,
      id, to, from, userId, JSON.stringify({ from, to, note: body.note ?? null })),
  ]);
  if (!changed.length) return c.json({ error: "the application changed meanwhile; reload and retry" }, 409);
  return c.json({ ok: true, state: to });
});

/** F4 blacklist and tiers. */
api.put("/companies/:companyId/preference", async (c) => {
  const companyId = c.req.param("companyId");
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) return c.json({ error: "bad company id" }, 400);
  const b = await c.req
    .json<{ tier?: string | null; blockMode?: string | null; reason?: string | null; expiresAt?: string | null; includeSubsidiaries?: boolean }>()
    .catch(() => ({}) as Record<string, never>);
  const tier = b.tier ?? null;
  const blockMode = b.blockMode ?? null;
  if (tier !== null && !["warmup", "mid", "dream"].includes(tier)) return c.json({ error: "invalid tier" }, 400);
  if (blockMode !== null && !["hard", "soft"].includes(blockMode)) return c.json({ error: "invalid blockMode" }, 400);
  if (b.expiresAt && Number.isNaN(Date.parse(b.expiresAt))) return c.json({ error: "invalid expiresAt" }, 400);

  const userId = c.get("userId");
  await c.get("db").asUser(userId, [
    stmt(`INSERT INTO mca.company_preference (user_id, company_id, tier, block_mode, block_reason, block_expires_at, include_subsidiaries)
      VALUES ($1, $2, $3, $4, $5, $6::date, $7)
      ON CONFLICT (user_id, company_id) DO UPDATE SET
        tier = EXCLUDED.tier, block_mode = EXCLUDED.block_mode, block_reason = EXCLUDED.block_reason,
        block_expires_at = EXCLUDED.block_expires_at, include_subsidiaries = EXCLUDED.include_subsidiaries`,
      userId, companyId, tier, blockMode, b.reason ?? null, b.expiresAt ?? null, Boolean(b.includeSubsidiaries)),
  ]);
  return c.json({ ok: true });
});
