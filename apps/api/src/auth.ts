// Beta loop B1: accounts. Email and password with PBKDF2, server-side sessions in an HttpOnly
// cookie, personal access tokens for agents, invite-only sign-up, export and deletion.
//
// Why not a framework: every check here runs through the same tested database seam as the rest
// of the API, the tables are reachable only through definer functions, and there is nothing to
// configure. Passwords and tokens never reach the database; only their hashes do.

import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "./env.js";
import { stmt, type TenantDb } from "./lib/tenant.js";

export const SESSION_COOKIE = "mca_session";
const SESSION_DAYS = 30;
// The Workers runtime caps PBKDF2 at 100,000 iterations. That costs about 15 ms of CPU, more than
// the Workers Free plan's 10 ms; set PBKDF2_ITERATIONS lower there. Stored hashes carry their own
// count, and a login re-hashes with the current setting, so raising it later upgrades everyone.
const DEFAULT_ITERATIONS = 100_000;
const iterationsFor = (env: Env) => Math.min(100_000, Math.max(10_000, Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS));
const TOKEN_PREFIX = "mca_pat_";

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomToken = (bytes = 32) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function equal(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

// A fixed hash to verify against when the email is unknown, so timing does not reveal accounts.
const DUMMY_HASH = "pbkdf2-sha256$20000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [alg, iter, salt, hash] = (stored ?? DUMMY_HASH).split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !salt || !hash) return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  return equal(got, unb64(hash)) && stored !== null;
}

/** 10 to 200 characters, not only whitespace, not the email. Length beats composition rules. */
export function passwordProblem(password: unknown, email: string): string | null {
  if (typeof password !== "string" || password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  if (!password.trim()) return "The password can't be only spaces.";
  if (password.toLowerCase() === email.toLowerCase()) return "Don't use your email as the password.";
  return null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const cleanEmail = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");

function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
const isSecure = (c: Context) => new URL(c.req.url).protocol === "https:";

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

async function startSession(c: Context<AppBindings>, db: TenantDb, userId: string) {
  const token = randomToken();
  await db.asSystem([stmt(`SELECT mca.session_create($1, $2, $3)`, await sha256(token), userId, SESSION_DAYS)]);
  c.header("Set-Cookie", cookieHeader(token, SESSION_DAYS * 86400, isSecure(c)));
}

/** Who is calling: a session cookie, a personal access token, or (POC) a configured API token. */
export async function resolveUser(env: Env, db: TenantDb, cookie: string | undefined, authorization: string | undefined,
  legacy: (header: string | undefined) => string | null): Promise<{ userId: string; via: "session" | "token" | "legacy"; sessionHash?: string } | null> {
  const session = readCookie(cookie, SESSION_COOKIE);
  if (session) {
    const h = await sha256(session);
    const [rows = []] = await db.asSystem([stmt(`SELECT mca.session_user($1) AS user_id`, h)]);
    const uid = rows[0]?.user_id as string | null | undefined;
    if (uid) return { userId: uid, via: "session", sessionHash: h };
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const [rows = []] = await db.asSystem([stmt(`SELECT mca.token_user($1) AS user_id`, await sha256(bearer))]);
    const uid = rows[0]?.user_id as string | null | undefined;
    return uid ? { userId: uid, via: "token" } : null;
  }
  const legacyUser = legacy(authorization);
  return legacyUser ? { userId: legacyUser, via: "legacy" } : null;
}

// ---------- public routes (no user yet) ----------

export const authPublic = new Hono<AppBindings>();

authPublic.post("/auth/signup", async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const email = cleanEmail(b.email);
  if (!EMAIL.test(email)) return c.json({ error: "Enter a valid email address." }, 400);
  const problem = passwordProblem(b.password, email);
  if (problem) return c.json({ error: problem }, 400);
  const required = c.env.INVITE_REQUIRED !== "false";
  const invite = typeof b.inviteCode === "string" ? b.inviteCode.trim() : "";
  if (required && !invite) return c.json({ error: "My Career Agent is invite-only during the beta. Enter your invite code." }, 400);
  const db = c.get("db");
  const userId = `u_${randomToken(12)}`;
  const [rows = []] = await db.asSystem([
    stmt(`SELECT mca.auth_signup($1, $2, $3, $4, $5) AS result`, userId, email, await hashPassword(b.password as string, iterationsFor(c.env)),
      invite ? await sha256(invite.toUpperCase()) : "", required),
  ]);
  const result = rows[0]?.result;
  if (result === "email_taken") return c.json({ error: "An account with this email already exists. Sign in instead." }, 409);
  if (result === "bad_invite") return c.json({ error: "That invite code isn't valid or was already used." }, 400);
  await startSession(c, db, userId);
  return c.json({ ok: true, userId }, 201);
});

authPublic.post("/auth/login", async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const email = cleanEmail(b.email);
  const password = typeof b.password === "string" ? b.password : "";
  const generic = { error: "That email and password don't match." };
  if (!email || !password) return c.json(generic, 401);
  const db = c.get("db");
  const emailHash = await sha256(email);
  const [rows = []] = await db.asSystem([stmt(`SELECT user_id, password_hash, locked FROM mca.auth_login_lookup($1, $2)`, email, emailHash)]);
  const row = rows[0];
  if (row?.locked) return c.json({ error: "Too many attempts. Wait 15 minutes and try again." }, 429);
  const ok = await verifyPassword(password, (row?.password_hash as string | null) ?? null);
  if (!ok || !row?.user_id) {
    await db.asSystem([stmt(`SELECT mca.auth_login_failed($1)`, emailHash)]);
    return c.json(generic, 401);
  }
  const uid = String(row.user_id);
  const storedIterations = Number(String(row.password_hash).split("$")[1]);
  if (storedIterations !== iterationsFor(c.env))
    await db.asSystem([stmt(`SELECT mca.auth_set_password($1, $2, $3)`, uid, await hashPassword(password, iterationsFor(c.env)), "")]);
  await startSession(c, db, uid);
  return c.json({ ok: true });
});

authPublic.post("/auth/logout", async (c) => {
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (token) await c.get("db").asSystem([stmt(`SELECT mca.session_end($1)`, await sha256(token))]);
  c.header("Set-Cookie", cookieHeader("", 0, isSecure(c)));
  return c.json({ ok: true });
});

// ---------- signed-in routes ----------

export const account = new Hono<AppBindings>();

/** Who am I, and how far through setup. Drives the onboarding wizard. */
account.get("/auth/me", async (c) => {
  const uid = c.get("userId");
  const db = c.get("db");
  const [[email] = [], [counts] = []] = await Promise.all([
    db.asSystem([stmt(`SELECT mca.account_email($1) AS email`, uid)]),
    db.asUser(uid, [
      stmt(`SELECT
        (SELECT count(*) FROM mca.app_user)::int AS profile,
        (SELECT count(*) FROM mca.work_auth)::int AS work_auth,
        (SELECT count(*) FROM mca.work_auth WHERE country = 'US')::int AS work_auth_us,
        (SELECT count(*) FROM mca.target)::int AS targets,
        (SELECT count(*) FROM mca.fact WHERE verified)::int AS facts,
        (SELECT count(*) FROM mca.user_language)::int AS languages,
        (SELECT count(*) FROM mca.answer_bank_entry WHERE question_key IN ('contact.full_name','contact.email'))::int AS contact_answers,
        (SELECT count(*) FROM mca.answer_bank_entry WHERE question_key LIKE 'us.%')::int AS visa_answers,
        (SELECT count(*) FROM mca.contact)::int AS contacts`),
    ]),
  ]).then(([a, b]) => [a[0] ?? [], b[0] ?? []] as const);
  const n = (k: string) => Number(counts?.[k] ?? 0);
  const steps = [
    { id: "work_auth", label: "Work authorization", done: n("work_auth") > 0 },
    { id: "targets", label: "Target roles", done: n("targets") > 0 },
    { id: "facts", label: "Your experience", done: n("facts") >= 3 },
    { id: "languages", label: "Languages", done: n("languages") > 0 },
    { id: "answers", label: "Essential answers", done: n("contact_answers") >= 2 && (n("work_auth_us") === 0 || n("visa_answers") >= 3) },
    { id: "network", label: "LinkedIn connections", done: n("contacts") > 0, optional: true },
  ];
  return c.json({
    userId: uid,
    email: (email?.email as string | null) ?? null,
    via: c.get("authVia"),
    hasProfile: n("profile") > 0,
    onboarding: { steps, complete: steps.filter((s) => !s.optional).every((s) => s.done) },
  });
});

/** POC users (signed in with an API token) attach an email and password to their existing data. */
account.post("/auth/claim", async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const email = cleanEmail(b.email);
  if (!EMAIL.test(email)) return c.json({ error: "Enter a valid email address." }, 400);
  const problem = passwordProblem(b.password, email);
  if (problem) return c.json({ error: problem }, 400);
  const db = c.get("db");
  const uid = c.get("userId");
  const [rows = []] = await db.asSystem([stmt(`SELECT mca.auth_claim($1, $2, $3) AS result`, uid, email, await hashPassword(b.password as string, iterationsFor(c.env)))]);
  const result = rows[0]?.result;
  if (result === "already_claimed") return c.json({ error: "This account already has a sign-in." }, 409);
  if (result === "email_taken") return c.json({ error: "Another account uses this email." }, 409);
  await startSession(c, db, uid);
  return c.json({ ok: true });
});

account.post("/auth/password", async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const db = c.get("db");
  const uid = c.get("userId");
  const [[row] = [], [em] = []] = await Promise.all([
    db.asSystem([stmt(`SELECT mca.auth_password_hash($1) AS h`, uid)]),
    db.asSystem([stmt(`SELECT mca.account_email($1) AS email`, uid)]),
  ]).then(([a, b2]) => [a[0] ?? [], b2[0] ?? []] as const);
  if (!(await verifyPassword(typeof b.current === "string" ? b.current : "", (row?.h as string | null) ?? null)))
    return c.json({ error: "Your current password is wrong." }, 403);
  const problem = passwordProblem(b.next, String(em?.email ?? ""));
  if (problem) return c.json({ error: problem }, 400);
  await db.asSystem([stmt(`SELECT mca.auth_set_password($1, $2, $3)`, uid, await hashPassword(b.next as string, iterationsFor(c.env)), c.get("sessionHash") ?? null)]);
  return c.json({ ok: true });
});

// Personal access tokens: shown once, stored hashed, revocable.
account.get("/tokens", async (c) => {
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT id, name, prefix, created_at, last_used_at FROM mca.api_token WHERE revoked_at IS NULL ORDER BY created_at DESC`),
  ]);
  return c.json({ items: rows });
});

account.post("/tokens", async (c) => {
  const b = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "Name the token, e.g. 'Claude connector'." }, 400);
  const token = `${TOKEN_PREFIX}${randomToken(24)}`;
  const uid = c.get("userId");
  const [rows = []] = await c.get("db").asUser(uid, [
    stmt(`SELECT count(*)::int AS n FROM mca.api_token WHERE revoked_at IS NULL`),
    stmt(`INSERT INTO mca.api_token (user_id, name, token_hash, prefix) SELECT $1, $2, $3, $4
          WHERE (SELECT count(*) FROM mca.api_token WHERE revoked_at IS NULL) < 10 RETURNING id`,
      uid, name, await sha256(token), token.slice(0, TOKEN_PREFIX.length + 4)),
  ]).then((r) => [r[1] ?? []]);
  if (!rows.length) return c.json({ error: "You have 10 active tokens. Revoke one first." }, 409);
  return c.json({ id: rows[0]?.id, token, note: "Copy it now. It won't be shown again." }, 201);
});

account.delete("/tokens/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "bad token id" }, 400);
  const [rows = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`UPDATE mca.api_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, id),
  ]);
  return rows.length ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

const EXPORT_TABLES = [
  "app_user", "work_auth", "target", "fact", "user_language", "company_preference", "contact", "answer_bank_entry",
  "application", "application_answer", "application_event", "inbound_email", "queue_run",
] as const;

/** Everything stored about the user, as one JSON file (GDPR access and portability). */
account.get("/account/export", async (c) => {
  const uid = c.get("userId");
  const results = await c.get("db").asUser(uid, EXPORT_TABLES.map((t) => stmt(`SELECT * FROM mca.${t}`)));
  const [email] = (await c.get("db").asSystem([stmt(`SELECT mca.account_email($1) AS email`, uid)]))[0] ?? [];
  const data: Record<string, unknown> = { exportedAt: new Date().toISOString(), account: { userId: uid, email: email?.email ?? null } };
  EXPORT_TABLES.forEach((t, i) => { data[t] = results[i] ?? []; });
  c.header("Content-Disposition", `attachment; filename="my-career-agent-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(data);
});

/** Permanent deletion. Requires the password (or, for POC token users, the typed confirmation). */
account.delete("/account", async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (b.confirm !== "DELETE") return c.json({ error: "Type DELETE to confirm." }, 400);
  const db = c.get("db");
  const uid = c.get("userId");
  const [rows = []] = await db.asSystem([stmt(`SELECT mca.auth_password_hash($1) AS h`, uid)]);
  const stored = (rows[0]?.h as string | null) ?? null;
  if (stored && !(await verifyPassword(typeof b.password === "string" ? b.password : "", stored)))
    return c.json({ error: "Your password is wrong." }, 403);
  await db.asSystem([stmt(`SELECT mca.account_delete($1)`, uid)]);
  c.header("Set-Cookie", cookieHeader("", 0, isSecure(c)));
  return c.json({ ok: true });
});

/** Admins (ADMIN_USER_IDS) create single-use invite codes. */
account.post("/admin/invites", async (c) => {
  const admins = (c.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(c.get("userId"))) return c.json({ error: "not allowed" }, 403);
  const b = await c.req.json<{ count?: unknown; note?: unknown }>().catch(() => ({}) as { count?: unknown; note?: unknown });
  const count = Math.min(50, Math.max(1, Number.isInteger(b.count) ? (b.count as number) : 1));
  const note = typeof b.note === "string" ? b.note.slice(0, 200) : null;
  const codes = Array.from({ length: count }, () => randomToken(9).replace(/[-_]/g, "").slice(0, 10).toUpperCase());
  await c.get("db").asSystem(await Promise.all(codes.map(async (code) => stmt(`SELECT mca.invite_create($1, $2, $3)`, await sha256(code), note, c.get("userId")))));
  return c.json({ codes });
});
