// Gmail, as an alternative to a forwarding domain. The person signs in with Google and grants the
// gmail.metadata scope: senders, subjects and dates, never message bodies. A sync (the GitHub job
// every 3 hours, or right after connecting or "Check now") reads new inbox messages, keeps only
// job-related ones, and moves applications through the same code as forwarded mail.
//
// Connecting: Google redirects to /api/gmail/callback, which hands code and state to the page; the
// page sends them back with its own sign-in, and the state must name that same user. A stranger
// can't link their mailbox to your account, or yours to theirs.

import { Hono } from "hono";
import type { AppBindings, Env } from "./env.js";
import { decryptSecret, encryptSecret } from "./ai.js";
import { isJobEmail, processForUser } from "./email.js";
import { startJobs } from "./lib/jobs.js";
import { stmt, type TenantDb } from "./lib/tenant.js";

export const gmail = new Hono<AppBindings>();
export const gmailPublic = new Hono<AppBindings>();

const SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const PURPOSE = "gmail-token";
const STATE_TTL_MS = 10 * 60_000;
const BACKFILL_DAYS = 30;

const enabled = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AI_KEY_SECRET);
const redirectUri = (url: string) => `${new URL(url).origin}/api/gmail/callback`;

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`my-career-agent:gmail-state:${env.AI_KEY_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}
export async function makeState(env: Env, userId: string, now = Date.now()): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: userId, e: now + STATE_TTL_MS, n: b64url(crypto.getRandomValues(new Uint8Array(9))) })));
  return `${payload}.${await sign(env, payload)}`;
}
export async function stateUser(env: Env, state: string, now = Date.now()): Promise<string | null> {
  const [payload, mac] = state.split(".");
  if (!payload || !mac || (await sign(env, payload)) !== mac) return null;
  try {
    const v = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { u: string; e: number };
    return v.e > now ? v.u : null;
  } catch {
    return null;
  }
}

async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, init);
  const body = (await r.json().catch(() => ({}))) as T & { error?: string | { message?: string; status?: string } };
  if (!r.ok) {
    const e = body.error;
    const err = new Error(typeof e === "string" ? e : (e?.message ?? `Google answered HTTP ${r.status}`)) as Error & { status: number; code?: string };
    err.status = r.status;
    err.code = typeof e === "string" ? e : e?.status;
    throw err;
  }
  return body;
}

// ------------------------------------------------------------------ routes

gmail.get("/gmail", async (c) => {
  const [[link] = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT email, connected_at, last_sync_at, last_error, history_id IS NULL AS first_sync_pending FROM mca.gmail_link`),
  ]);
  return c.json({ available: enabled(c.env), link: link ?? null });
});

gmail.post("/gmail/connect", async (c) => {
  if (!enabled(c.env)) return c.json({ error: "Gmail isn't set up on this server yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see DEPLOY.md)." }, 503);
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c.req.url),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: await makeState(c.env, c.get("userId")),
  });
  return c.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
});

gmail.post("/gmail/exchange", async (c) => {
  if (!enabled(c.env)) return c.json({ error: "Gmail isn't set up on this server yet." }, 503);
  const uid = c.get("userId");
  const b = await c.req.json<{ code?: string; state?: string }>().catch(() => ({}) as { code?: string; state?: string });
  if (!b.code || !b.state) return c.json({ error: "code and state are required" }, 400);
  if ((await stateUser(c.env, b.state)) !== uid)
    return c.json({ error: "This Google sign-in was started from a different session or has expired. Start again from Settings." }, 400);
  const tok = await google<{ refresh_token?: string; access_token: string; scope?: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: b.code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri(c.req.url), grant_type: "authorization_code" }),
  }).catch((e: Error) => e);
  if (tok instanceof Error) return c.json({ error: `Google refused the sign-in: ${tok.message}. Start again from Settings.` }, 502);
  if (!tok.refresh_token) return c.json({ error: "Google didn't grant ongoing access. Start again and allow access when asked." }, 502);
  if (tok.scope && !tok.scope.split(" ").includes(SCOPE))
    return c.json({ error: "Gmail access wasn't granted. Start again and tick the Gmail permission." }, 400);
  const profile = await google<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${tok.access_token}` } });
  const enc = await encryptSecret(c.env, tok.refresh_token, uid, PURPOSE);
  await c.get("db").asUser(uid, [
    stmt(`INSERT INTO mca.gmail_link (user_id, email, token_ct, token_iv) VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, token_ct = EXCLUDED.token_ct, token_iv = EXCLUDED.token_iv,
            history_id = NULL, connected_at = now(), last_error = NULL`, uid, profile.emailAddress, enc.ciphertext, enc.iv),
  ]);
  // First sync now, if the GitHub job can be started; otherwise within 3 hours.
  const started = c.env.GITHUB_DISPATCH_TOKEN && c.env.GITHUB_REPO ? (await startJobs(c.env, { stale_minutes: "60" }).catch(() => null))?.status === 204 : false;
  return c.json({ email: profile.emailAddress, syncStarted: started });
});

gmail.post("/gmail/sync", async (c) => {
  const [[link] = []] = await c.get("db").asUser(c.get("userId"), [stmt(`SELECT 1 AS x FROM mca.gmail_link`)]);
  if (!link) return c.json({ error: "Connect Gmail first." }, 409);
  if (!c.env.GITHUB_DISPATCH_TOKEN || !c.env.GITHUB_REPO) return c.json({ error: "Checking on demand isn't set up; Gmail is checked every 3 hours." }, 503);
  const r = await startJobs(c.env, { stale_minutes: "60" });
  if (r.status !== 204) return c.json({ error: `GitHub didn't start the check (HTTP ${r.status}).` }, 502);
  return c.json({ started: true });
});

gmail.delete("/gmail", async (c) => {
  const uid = c.get("userId");
  const db = c.get("db");
  const [[link] = []] = await db.asUser(uid, [stmt(`SELECT token_ct, token_iv FROM mca.gmail_link`)]);
  if (link && c.env.AI_KEY_SECRET) {
    // Tell Google too, so the grant disappears from the person's Google account.
    const token = await decryptSecret(c.env, String(link.token_ct), String(link.token_iv), uid, PURPOSE).catch(() => null);
    if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
  }
  await db.asUser(uid, [stmt(`DELETE FROM mca.gmail_link`)]);
  return c.json({ ok: true });
});

/** Google sends the browser here; the page finishes the connection with its own sign-in. */
gmailPublic.get("/gmail/callback", (c) => {
  const u = new URL(c.req.url);
  const q = new URLSearchParams();
  for (const k of ["code", "state", "error"]) { const v = u.searchParams.get(k); if (v) q.set(k, v); }
  return c.redirect(`/#/gmail?${q}`, 302);
});

// ------------------------------------------------------------------ sync

type Header = { name: string; value: string };
interface Meta { id: string; internalDate: string; payload?: { headers?: Header[] } }

export interface SyncResult { read: number; stored: number; moved: number; error?: string }

/** Reads new inbox messages for one user and records the job-related ones. */
export async function syncGmail(env: Env, db: TenantDb, userId: string, opts: { maxMessages?: number; now?: Date } = {}): Promise<SyncResult> {
  const max = opts.maxMessages ?? 300;
  const now = opts.now ?? new Date();
  const [[link] = []] = await db.asUser(userId, [stmt(`SELECT token_ct, token_iv, history_id FROM mca.gmail_link`)]);
  if (!link) return { read: 0, stored: 0, moved: 0 };
  const fail = async (msg: string) => {
    await db.asUser(userId, [stmt(`UPDATE mca.gmail_link SET last_error = $1, last_sync_at = now()`, msg)]);
    return { read: 0, stored: 0, moved: 0, error: msg };
  };

  let access: string;
  try {
    const refresh = await decryptSecret(env, String(link.token_ct), String(link.token_iv), userId, PURPOSE);
    const t = await google<{ access_token: string }>("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" }),
    });
    access = t.access_token;
  } catch (e) {
    const code = (e as { code?: string }).code;
    return fail(code === "invalid_grant" ? "Google access was removed or expired. Connect Gmail again." : `Couldn't reach Google: ${(e as Error).message}`);
  }
  const auth = { headers: { authorization: `Bearer ${access}` } };
  const api = "https://gmail.googleapis.com/gmail/v1/users/me";

  try {
    // Where the next sync starts: taken before reading, so nothing arriving meanwhile is missed.
    const { historyId: latest } = await google<{ historyId: string }>(`${api}/profile`, auth);
    let ids: string[] = [];
    let since: number | null = null;
    if (link.history_id) {
      try {
        let page: string | undefined;
        do {
          const h = await google<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>; nextPageToken?: string }>(
            `${api}/history?${new URLSearchParams({ startHistoryId: String(link.history_id), historyTypes: "messageAdded", labelId: "INBOX", maxResults: "500", ...(page ? { pageToken: page } : {}) })}`, auth);
          for (const r of h.history ?? []) for (const m of r.messagesAdded ?? []) ids.push(m.message.id);
          page = h.nextPageToken;
        } while (page && ids.length < max);
      } catch (e) {
        // History is kept for about a week; after a long gap, read the last week instead.
        if ((e as { status?: number }).status !== 404) throw e;
        ids = [];
        since = now.getTime() - 7 * 86_400_000;
      }
    } else since = now.getTime() - BACKFILL_DAYS * 86_400_000;

    if (since !== null) {
      // Newest first; stop at the first page that reaches past the cut-off (checked per message).
      let page: string | undefined;
      do {
        const l = await google<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
          `${api}/messages?${new URLSearchParams({ labelIds: "INBOX", maxResults: "100", ...(page ? { pageToken: page } : {}) })}`, auth);
        ids.push(...(l.messages ?? []).map((m) => m.id));
        page = l.nextPageToken;
      } while (page && ids.length < max);
    }

    let read = 0, stored = 0, moved = 0;
    const metas: Meta[] = [];
    for (const id of [...new Set(ids)].slice(0, max)) {
      const m = await google<Meta>(`${api}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, auth).catch((e) => {
        if ((e as { status?: number }).status === 404) return null; // deleted since
        throw e;
      });
      if (!m) continue;
      if (since !== null && Number(m.internalDate) < since) break;
      metas.push(m);
    }
    // Oldest first, so a confirmation is applied before a later rejection of the same application.
    metas.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    for (const m of metas) {
      read++;
      const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
      const from = h("from"), subject = h("subject");
      if (!isJobEmail(from, subject)) continue;
      const r = await processForUser(db, userId, { from, subject, source: "gmail", externalId: m.id, receivedAt: new Date(Number(m.internalDate)) });
      if (!r.duplicate && r.status) stored++;
      if (r.status === "pending") moved++; // suggestions waiting for the person
    }
    await db.asUser(userId, [stmt(`UPDATE mca.gmail_link SET history_id = $1, last_sync_at = now(), last_error = NULL`, latest)]);
    return { read, stored, moved };
  } catch (e) {
    return fail(`Gmail sync failed: ${(e as Error).message}`);
  }
}
