// Connect Gmail: the sign-in handshake, encrypted token storage, and the sync that moves applications
// from job emails while skipping (and never storing) everything else in the inbox.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeState, stateUser, syncGmail } from "../src/gmail.js";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let appId: string;

type Msg = { id: string; from: string; subject: string; at: number };
let inbox: Msg[] = [];
let historyAdded: string[] = [];
let calls: string[] = [];
let grantRevoked = false;

function google(opts: { refreshFails?: boolean } = {}) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: unknown }) => {
    const u = new URL(url);
    calls.push(`${u.host}${u.pathname}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code")
        return json({ access_token: "at-1", refresh_token: "rt-secret", scope: "https://www.googleapis.com/auth/gmail.metadata" });
      if (opts.refreshFails) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at-2" });
    }
    if (u.pathname === "/revoke") { grantRevoked = true; return new Response("", { status: 200 }); }
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: "ayush@gmail.com", historyId: "900" });
    if (u.pathname.endsWith("/history")) return json({ history: [{ messagesAdded: historyAdded.map((id) => ({ message: { id } })) }] });
    if (u.pathname.endsWith("/messages")) return json({ messages: [...inbox].sort((a, b) => b.at - a.at).map((m) => ({ id: m.id })) });
    const m = /\/messages\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const msg = inbox.find((x) => x.id === m[1]);
      if (!msg) return json({ error: { message: "Not Found" } }, 404);
      return json({ id: msg.id, internalDate: String(msg.at), payload: { headers: [{ name: "From", value: msg.from }, { name: "Subject", value: msg.subject }] } });
    }
    return json({ error: "unexpected" }, 500);
  });
}

beforeAll(async () => {
  h = await harness();
  h.env.AI_KEY_SECRET = "test-secret-value-0123456789";
  h.env.GOOGLE_CLIENT_ID = "client-id";
  h.env.GOOGLE_CLIENT_SECRET = "client-secret";
  await h.setupProfile(TOKEN_A);
  await h.setupProfile(TOKEN_B);
  const co = await h.addCompany("Acme", []);
  const r = await h.json(await h.call("POST", "/queue/build", TOKEN_A));
  expect(r.queued).toBeGreaterThan(0);
  const q = await h.json(await h.call("GET", "/queue", TOKEN_A));
  appId = q.items.find((i: { company: string }) => i.company === "Acme").id;
  expect((await h.call("POST", `/applications/${appId}/status`, TOKEN_A, { state: "approved" })).status).toBe(200);
  void co;
});
afterEach(() => vi.unstubAllGlobals());

describe("Connect Gmail", () => {
  it("says what's missing when the server has no Google client", async () => {
    const id = h.env.GOOGLE_CLIENT_ID;
    h.env.GOOGLE_CLIENT_ID = undefined;
    expect((await h.json(await h.call("GET", "/gmail", TOKEN_A))).available).toBe(false);
    const r = await h.call("POST", "/gmail/connect", TOKEN_A);
    expect(r.status).toBe(503);
    expect((await h.json(r)).error).toMatch(/GOOGLE_CLIENT_ID/);
    h.env.GOOGLE_CLIENT_ID = id;
  });

  it("asks Google for the metadata scope only, with a signed state for this user", async () => {
    const { url } = await h.json(await h.call("POST", "/gmail/connect", TOKEN_A));
    const u = new URL(url);
    expect(u.host).toBe("accounts.google.com");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.metadata");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/api\/gmail\/callback$/);
    expect(await stateUser(h.env, u.searchParams.get("state")!)).toBe("alice");
  });

  it("rejects a state that's forged, expired, or for another user", async () => {
    const good = await makeState(h.env, "alice");
    expect(await stateUser(h.env, good.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(await stateUser(h.env, await makeState(h.env, "alice", Date.now() - 11 * 60_000))).toBeNull();
    google();
    const r = await h.call("POST", "/gmail/exchange", TOKEN_B, { code: "c", state: good });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]); // never reached Google
  });

  it("the callback hands code and state to the page", async () => {
    const r = await h.call("GET", "/gmail/callback?code=abc&state=xyz&scope=s", null);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/#/gmail?code=abc&state=xyz");
  });

  it("stores the refresh token encrypted and shows the linked address", async () => {
    google();
    const state = await makeState(h.env, "alice");
    const r = await h.json(await h.call("POST", "/gmail/exchange", TOKEN_A, { code: "c", state }));
    expect(r.email).toBe("ayush@gmail.com");
    const { rows } = await h.pg.query<{ token_ct: string }>("SELECT token_ct FROM mca.gmail_link WHERE user_id = 'alice'");
    expect(rows[0]!.token_ct).not.toContain("rt-secret");
    const g = await h.json(await h.call("GET", "/gmail", TOKEN_A));
    expect(g.link).toMatchObject({ email: "ayush@gmail.com", first_sync_pending: true });
    expect((await h.json(await h.call("GET", "/gmail", TOKEN_B))).link).toBeNull(); // RLS
  });
});

describe("Gmail sync", () => {
  const day = 86_400_000;
  const now = new Date("2026-11-25T12:00:00Z");

  it("first sync reads the last 30 days, records job emails only, and moves the application", async () => {
    inbox = [
      { id: "m1", from: "Acme Recruiting <no-reply@acme.com>", subject: "Thank you for applying to Acme", at: now.getTime() - 3 * day },
      { id: "m2", from: "Mom <mom@example.com>", subject: "Dinner on Sunday?", at: now.getTime() - 2 * day },
      { id: "m3", from: "Bank <alerts@bank.com>", subject: "Your statement is ready", at: now.getTime() - day },
      { id: "old", from: "Acme <jobs@acme.com>", subject: "Thank you for applying to Acme", at: now.getTime() - 40 * day },
    ];
    google();
    const r = await syncGmail(h.env, h.env.TEST_DB!, "alice", { now });
    expect(r).toMatchObject({ stored: 1, moved: 1 });
    const { rows } = await h.pg.query<{ subject: string; source: string }>("SELECT subject, source FROM mca.inbound_email WHERE user_id = 'alice'");
    expect(rows).toEqual([{ subject: "Thank you for applying to Acme", source: "gmail" }]); // nothing personal stored
    const { rows: app } = await h.pg.query<{ state: string }>("SELECT state FROM mca.application WHERE id = $1", [appId]);
    expect(app[0]!.state).toBe("submitted");
    expect(calls.some((c) => c.endsWith("/messages/old"))).toBe(true); // reached the cut-off, then stopped
    const { rows: link } = await h.pg.query<{ history_id: string; last_error: string | null }>("SELECT history_id, last_error FROM mca.gmail_link");
    expect(link[0]).toEqual({ history_id: "900", last_error: null });
  });

  it("later syncs read only new messages, oldest first, and never count one twice", async () => {
    inbox.push(
      { id: "m4", from: "Acme <no-reply@greenhouse.io>", subject: "Acme: next steps - schedule an interview", at: now.getTime() + 1000 },
      { id: "m5", from: "Newsletter <hi@news.com>", subject: "Weekly digest", at: now.getTime() + 2000 },
    );
    historyAdded = ["m1", "m4", "m5"]; // m1 again: already recorded
    google();
    const r = await syncGmail(h.env, h.env.TEST_DB!, "alice", { now });
    expect(r).toMatchObject({ stored: 1, moved: 1 });
    expect(calls.some((c) => c.endsWith("/history"))).toBe(true);
    const { rows: app } = await h.pg.query<{ state: string }>("SELECT state FROM mca.application WHERE id = $1", [appId]);
    expect(app[0]!.state).toBe("screen");
    const { rows } = await h.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mca.inbound_email WHERE user_id = 'alice'");
    expect(rows[0]!.n).toBe(2);
  });

  it("a revoked grant is reported plainly, not retried silently", async () => {
    google({ refreshFails: true });
    const r = await syncGmail(h.env, h.env.TEST_DB!, "alice", { now });
    expect(r.error).toMatch(/Connect Gmail again/);
    expect((await h.json(await h.call("GET", "/gmail", TOKEN_A))).link.last_error).toMatch(/Connect Gmail again/);
  });

  it("disconnecting revokes the grant at Google and deletes the token", async () => {
    google();
    grantRevoked = false;
    expect((await h.call("DELETE", "/gmail", TOKEN_A)).status).toBe(200);
    expect(grantRevoked).toBe(true);
    expect((await h.json(await h.call("GET", "/gmail", TOKEN_A))).link).toBeNull();
  });
});
