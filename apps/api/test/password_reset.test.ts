// Forgot password: one-time, 30-minute links; the same answer for known and unknown emails; every
// session ends when the password changes; email goes out through whichever provider is configured.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { harness } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
const EMAIL = "reset.me@example.com";
const OLD = "the old password 123";
const NEW = "a brand new password 456";
let sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
let cookie: string;

const linkToken = () => /#\/reset\/([A-Za-z0-9_-]+)/.exec(sent.at(-1)!.text)![1]!;

beforeAll(async () => {
  h = await harness();
  h.env.INVITE_REQUIRED = "false";
  h.env.MAIL_FROM = "noreply@mycareeragent.dev";
  h.env.APP_URL = "https://app.mycareeragent.dev";
  h.env.EMAIL = { send: async (m) => { sent.push({ to: m.to, subject: m.subject, text: m.text ?? "", html: m.html ?? "" }); return {}; } };
  const r = await h.browser("POST", "/auth/signup", null, { email: EMAIL, password: OLD });
  expect(r.status).toBe(201);
  cookie = h.cookieOf(r);
});
afterEach(() => vi.unstubAllGlobals());

describe("Forgot password", () => {
  it("is offered only when the server can send email", async () => {
    expect((await h.json(await h.browser("GET", "/auth/reset/available", null))).available).toBe(true);
    const from = h.env.MAIL_FROM;
    h.env.MAIL_FROM = undefined;
    expect((await h.json(await h.browser("GET", "/auth/reset/available", null))).available).toBe(false);
    expect((await h.browser("POST", "/auth/forgot", null, { email: EMAIL })).status).toBe(503);
    h.env.MAIL_FROM = from;
  });

  it("answers the same for an unknown email and sends nothing", async () => {
    sent = [];
    const known = await h.json(await h.browser("POST", "/auth/forgot", null, { email: EMAIL.toUpperCase() }));
    const unknown = await h.json(await h.browser("POST", "/auth/forgot", null, { email: "nobody@example.com" }));
    expect(unknown).toEqual(known);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: EMAIL, subject: "Reset your My Career Agent password" });
    expect(sent[0]!.text).toContain("https://app.mycareeragent.dev/#/reset/");
    expect(sent[0]!.text).toMatch(/didn't ask, ignore this email/);
  });

  it("stores only a hash of the token", async () => {
    const { rows } = await h.pg.query<{ token_hash: string }>("SELECT token_hash FROM mca.password_reset");
    expect(rows.map((r) => r.token_hash)).not.toContain(linkToken());
  });

  it("checks the link, enforces password rules, then sets the password and signs out everywhere", async () => {
    const token = linkToken();
    expect((await h.json(await h.browser("POST", "/auth/reset/check", null, { token }))).valid).toBe(true);
    expect((await h.json(await h.browser("POST", "/auth/reset", null, { token, password: "short" }))).error).toMatch(/10 characters/);
    expect((await h.json(await h.browser("POST", "/auth/reset", null, { token, password: EMAIL }))).error).toMatch(/email/);
    const r = await h.browser("POST", "/auth/reset", null, { token, password: NEW });
    expect(r.status).toBe(200);
    const fresh = h.cookieOf(r);
    expect((await h.browser("GET", "/auth/me", fresh)).status).toBe(200); // this browser is signed in
    expect((await h.browser("GET", "/auth/me", cookie)).status).toBe(401); // the old session ended
    expect((await h.browser("POST", "/auth/login", null, { email: EMAIL, password: OLD })).status).toBe(401);
    expect((await h.browser("POST", "/auth/login", null, { email: EMAIL, password: NEW })).status).toBe(200);
  });

  it("a link works once", async () => {
    const token = linkToken();
    expect((await h.json(await h.browser("POST", "/auth/reset/check", null, { token }))).valid).toBe(false);
    expect((await h.json(await h.browser("POST", "/auth/reset", null, { token, password: "yet another password 789" }))).error).toMatch(/expired or was already used/);
  });

  it("expires after 30 minutes, and a new link closes older ones", async () => {
    sent = [];
    await h.browser("POST", "/auth/forgot", null, { email: EMAIL });
    const first = linkToken();
    await h.browser("POST", "/auth/forgot", null, { email: EMAIL });
    const second = linkToken();
    await h.pg.query("UPDATE mca.password_reset SET expires_at = now() - interval '1 minute' WHERE created_at = (SELECT max(created_at) FROM mca.password_reset)");
    expect((await h.json(await h.browser("POST", "/auth/reset/check", null, { token: second }))).valid).toBe(false);
    expect((await h.browser("POST", "/auth/reset", null, { token: first, password: "third password abc 1" })).status).toBe(200);
  });

  it("limits requests to 3 an hour per account, still answering the same", async () => {
    await h.pg.query("DELETE FROM mca.password_reset");
    sent = [];
    for (let i = 0; i < 5; i++) expect((await h.browser("POST", "/auth/forgot", null, { email: EMAIL })).status).toBe(200);
    expect(sent).toHaveLength(3);
  });

  it("sends through Resend when that's the configured provider", async () => {
    const binding = h.env.EMAIL;
    h.env.EMAIL = undefined;
    h.env.RESEND_API_KEY = "re_test_key";
    await h.pg.query("DELETE FROM mca.password_reset");
    let body: { from: string; to: string[]; subject: string } | null = null;
    let auth = "";
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
      expect(url).toBe("https://api.resend.com/emails");
      auth = init.headers.authorization!;
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "1" }), { status: 200 });
    });
    await h.browser("POST", "/auth/forgot", null, { email: EMAIL });
    expect(auth).toBe("Bearer re_test_key");
    expect(body).toMatchObject({ from: "My Career Agent <noreply@mycareeragent.dev>", to: [EMAIL] });
    h.env.EMAIL = binding;
    h.env.RESEND_API_KEY = undefined;
  });
});
