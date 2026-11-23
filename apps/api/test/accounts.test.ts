// Beta loop B1: accounts, sessions, tokens, export and deletion, end to end.
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let invites: string[];
let cookie: string;
const EMAIL = "Priya@Example.com";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  h = await harness();
  invites = (await h.json(await h.call("POST", "/admin/invites", TOKEN_A, { count: 3, note: "beta" }))).codes;
});

describe("sign-up", () => {
  it("is invite-only and checks the email and password", async () => {
    expect((await h.browser("POST", "/auth/signup", null, { email: EMAIL, password: PASSWORD })).status).toBe(400);
    expect((await h.json(await h.browser("POST", "/auth/signup", null, { email: EMAIL, password: PASSWORD, inviteCode: "NOPE" }))).error).toMatch(/invite code/);
    expect((await h.json(await h.browser("POST", "/auth/signup", null, { email: "x", password: PASSWORD, inviteCode: invites[0] }))).error).toMatch(/valid email/);
    expect((await h.json(await h.browser("POST", "/auth/signup", null, { email: EMAIL, password: "short", inviteCode: invites[0] }))).error).toMatch(/10 characters/);
  });

  it("creates the account, starts a session, and reports onboarding progress", async () => {
    const r = await h.browser("POST", "/auth/signup", null, { email: EMAIL, password: PASSWORD, inviteCode: invites[0]!.toLowerCase() });
    expect(r.status).toBe(201);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    cookie = h.cookieOf(r);
    const me = await h.json(await h.browser("GET", "/auth/me", cookie));
    expect(me).toMatchObject({ email: "priya@example.com", via: "session", hasProfile: true, onboarding: { complete: false } });
    expect(me.onboarding.steps.map((s: { id: string }) => s.id)).toEqual(["work_auth", "targets", "facts", "languages", "answers", "network"]);
  });

  it("refuses a used invite and a duplicate email", async () => {
    expect((await h.browser("POST", "/auth/signup", null, { email: "other@example.com", password: PASSWORD, inviteCode: invites[0] })).status).toBe(400);
    expect((await h.browser("POST", "/auth/signup", null, { email: "PRIYA@example.com", password: PASSWORD, inviteCode: invites[1] })).status).toBe(409);
  });
});

describe("sessions", () => {
  it("refuses cookie writes from another site but allows them from this one", async () => {
    expect((await h.browser("PUT", "/profile", cookie, { dailyTarget: 5 }, "https://evil.example")).status).toBe(403);
    expect((await h.browser("PUT", "/profile", cookie, { dailyTarget: 5 })).status).toBe(200);
  });

  it("signs in, rejects a wrong password with a generic message, and locks after 10 failures", async () => {
    const bad = await h.json(await h.browser("POST", "/auth/login", null, { email: EMAIL, password: "wrong password" }));
    expect(bad.error).toBe("That email and password don't match.");
    const unknown = await h.json(await h.browser("POST", "/auth/login", null, { email: "nobody@example.com", password: "wrong password" }));
    expect(unknown.error).toBe(bad.error);
    const ok = await h.browser("POST", "/auth/login", null, { email: EMAIL, password: PASSWORD });
    expect(ok.status).toBe(200);
    for (let i = 0; i < 10; i++) await h.browser("POST", "/auth/login", null, { email: "victim@example.com", password: "guess-" + i });
    expect((await h.browser("POST", "/auth/login", null, { email: "victim@example.com", password: "guess" })).status).toBe(429);
  });

  it("changing the password signs out other sessions", async () => {
    const second = h.cookieOf(await h.browser("POST", "/auth/login", null, { email: EMAIL, password: PASSWORD }));
    expect((await h.browser("POST", "/auth/password", cookie, { current: "nope", next: "another long password" })).status).toBe(403);
    expect((await h.browser("POST", "/auth/password", cookie, { current: PASSWORD, next: "another long password" })).status).toBe(200);
    expect((await h.browser("GET", "/auth/me", second)).status).toBe(401);
    expect((await h.browser("GET", "/auth/me", cookie)).status).toBe(200);
  });

  it("logs out", async () => {
    const c = h.cookieOf(await h.browser("POST", "/auth/login", null, { email: EMAIL, password: "another long password" }));
    await h.browser("POST", "/auth/logout", c);
    expect((await h.browser("GET", "/auth/me", c)).status).toBe(401);
  });
});

describe("personal access tokens", () => {
  it("are shown once, work as bearer tokens, and stop working when revoked", async () => {
    const t = await h.json(await h.browser("POST", "/tokens", cookie, { name: "Claude connector" }));
    expect(t.token).toMatch(/^mca_pat_/);
    expect((await h.call("GET", "/profile", t.token)).status).toBe(200);
    const list = await h.json(await h.browser("GET", "/tokens", cookie));
    expect(list.items[0]).toMatchObject({ name: "Claude connector", prefix: t.token.slice(0, 12) });
    expect(JSON.stringify(list)).not.toContain(t.token);
    await h.browser("DELETE", `/tokens/${t.id}`, cookie);
    expect((await h.call("GET", "/profile", t.token)).status).toBe(401);
  });
});

describe("export and deletion", () => {
  it("exports everything the user owns", async () => {
    await h.browser("POST", "/facts", cookie, [{ kind: "skill", text: "SQL", skills: ["sql"], verified: true }]);
    const r = await h.browser("GET", "/account/export", cookie);
    expect(r.headers.get("content-disposition")).toMatch(/attachment/);
    const data = await h.json(r);
    expect(data.account.email).toBe("priya@example.com");
    expect(data.fact).toHaveLength(1);
    expect(JSON.stringify(data)).not.toMatch(/pbkdf2/);
  });

  it("deletes the account and everything in it", async () => {
    expect((await h.browser("DELETE", "/account", cookie, { confirm: "DELETE", password: "wrong" })).status).toBe(403);
    expect((await h.browser("DELETE", "/account", cookie, { confirm: "DELETE", password: "another long password" })).status).toBe(200);
    expect((await h.browser("GET", "/auth/me", cookie)).status).toBe(401);
    expect((await h.browser("POST", "/auth/login", null, { email: EMAIL, password: "another long password" })).status).toBe(401);
    const left = await h.pg.query("SELECT count(*)::int AS n FROM mca.fact");
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("POC users claim an email and password", () => {
  it("keeps their data and lets them sign in", async () => {
    await h.call("PUT", "/profile", TOKEN_A, { dailyTarget: 7 });
    const r = await h.call("POST", "/auth/claim", TOKEN_A, { email: "founder@example.com", password: PASSWORD });
    expect(r.status).toBe(200);
    const c = h.cookieOf(await h.browser("POST", "/auth/login", null, { email: "founder@example.com", password: PASSWORD }));
    const p = await h.json(await h.browser("GET", "/profile", c));
    expect(p.settings.daily_target).toBe(7);
    expect((await h.call("POST", "/auth/claim", TOKEN_A, { email: "again@example.com", password: PASSWORD })).status).toBe(409);
  });
});
