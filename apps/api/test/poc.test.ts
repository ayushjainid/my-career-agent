// POC loops P0, P2 and P3, validated end to end: the real HTTP routes, the real migrations,
// row-level security on, an in-process Postgres instead of Neon. No network.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { app } from "../src/index.js";
import type { Row, TenantDb } from "../src/lib/tenant.js";
import { userForToken } from "../src/routes.js";

const TOKEN_A = "a".repeat(20) + "-token-alice";
const TOKEN_B = "b".repeat(20) + "-token-bob";

let pg: PGlite;
let env: Env;

function pgliteTenantDb(db: PGlite): TenantDb {
  return {
    asUser: (userId, stmts) =>
      db.transaction(async (tx) => {
        await tx.query("SET LOCAL ROLE mca_app");
        await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        const out: Row[][] = [];
        for (const s of stmts) out.push((await tx.query<Row>(s.text, s.params ?? [])).rows);
        return out;
      }),
  };
}

const call = (method: string, path: string, token: string | null, body?: unknown) =>
  app.fetch(
    new Request(`http://mca.test/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

const json = async (r: Response) => (await r.json()) as Record<string, any>;

const DESC = "<h2>Requirements</h2><ul><li>5+ years of Python</li><li>SQL</li><li>AWS</li></ul>";

beforeAll(async () => {
  pg = new PGlite();
  const dir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(dir + f, "utf8"));

  // Shared catalog, written as the owner (the ingest role's job in production).
  const companies = ["Acme", "Globex", "Initech", "Umbrella"];
  for (const [i, name] of companies.entries()) {
    const { rows } = await pg.query<{ id: string }>(
      "INSERT INTO mca.company (name, name_norm, ats_vendor, ats_board) VALUES ($1, upper($1), 'greenhouse', lower($1)) RETURNING id",
      [name],
    );
    const id = rows[0]!.id;
    const text = name === "Initech" ? `${DESC}\nFluent German required.` : name === "Umbrella" ? `${DESC}\nWe are unable to sponsor visas.` : DESC;
    await pg.query(
      `INSERT INTO mca.job (company_id, ats_vendor, ats_job_id, title, country, description_text, posted_at, status, integrity)
       VALUES ($1, 'greenhouse', $2, 'Senior Data Engineer', 'US', $3, now() - interval '2 days', 'open', '{"level":"clean"}')`,
      [id, String(100 + i), text.replace(/<[^>]+>/g, "\n")],
    );
    await pg.query(
      `INSERT INTO mca.sponsor_record (company_id, country, source, employer_name, employer_norm, filings, certified, period_end)
       VALUES ($1, 'US', 'dol_lca', $2, upper($2), 50, 0, '2026-09-30'), ($1, 'US', 'dol_perm', $2, upper($2), 0, 10, '2026-09-30')`,
      [id, name],
    );
  }

  env = {
    DATABASE_URL: "unused",
    INGEST_DATABASE_URL: "unused",
    DEV_MODE: "false",
    INGEST_BOARDS_PER_RUN: "1",
    INBOUND_DOMAIN: "in.example",
    API_TOKENS: `alice:${TOKEN_A},bob:${TOKEN_B}`,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    TEST_DB: pgliteTenantDb(pg),
  };
});

describe("P0 auth", () => {
  it("accepts only a known bearer token; the dev header is ignored outside DEV_MODE", async () => {
    expect((await call("GET", "/profile", null)).status).toBe(401);
    expect((await call("GET", "/profile", "wrong-token-wrong-token-xx")).status).toBe(401);
    const dev = await app.fetch(new Request("http://mca.test/api/profile", { headers: { "x-dev-user": "alice" } }), env);
    expect(dev.status).toBe(401);
    expect(userForToken(`Bearer ${TOKEN_A}`, env.API_TOKENS)).toBe("alice");
    expect(userForToken("Bearer short", "x:short")).toBeNull(); // tokens under 24 characters never match
  });
});

describe("P2 profile", () => {
  it("creates a profile, facts, languages, work authorization and a target", async () => {
    expect((await call("GET", "/profile", TOKEN_A)).status).toBe(404);
    expect((await call("PUT", "/profile", TOKEN_A, { homeCountry: "us", dailyTarget: 5 })).status).toBe(200);
    const facts = await call("POST", "/facts", TOKEN_A, [
      { kind: "role", text: "Data engineer at Hooli", skills: ["Python", "SQL", "aws"], startDate: "2018-01-01", verified: true },
      { kind: "achievement", text: "Cut pipeline cost by 40%", skills: ["python"] },
    ]);
    expect(facts.status).toBe(201);
    const ids = (await json(facts)).ids as string[];
    expect(ids).toHaveLength(2);
    expect((await call("PATCH", `/facts/${ids[1]}`, TOKEN_A, { verified: true })).status).toBe(200);
    expect((await call("PUT", "/languages", TOKEN_A, [{ language: "English", level: "C2" }])).status).toBe(200);
    expect((await call("PUT", "/work-auth/us", TOKEN_A, { status: "needs_sponsorship" })).status).toBe(200);
    expect((await call("POST", "/targets", TOKEN_A, { country: "US", title: "Data Engineer", seniority: "senior" })).status).toBe(201);

    const p = await json(await call("GET", "/profile", TOKEN_A));
    expect(p.facts).toEqual({ n: 2, verified: 2 });
    expect(p.languages).toEqual([{ language: "english", level: "C2" }]);
    expect(p.targets).toHaveLength(1);
  });

  it("rejects bad input with a clear message", async () => {
    expect(await json(await call("POST", "/facts", TOKEN_A, [{ kind: "hobby", text: "x" }]))).toMatchObject({ error: expect.stringMatching(/kind must be/) });
    expect((await call("POST", "/facts", TOKEN_A, [{ kind: "role", text: "x", startDate: "2020-01-01", endDate: "2019-01-01" }])).status).toBe(400);
    expect((await call("PUT", "/languages", TOKEN_A, [{ language: "French", level: "fluent" }])).status).toBe(400);
    expect((await call("PUT", "/work-auth/USA", TOKEN_A, { status: "citizen" })).status).toBe(400);
    expect((await call("PUT", "/profile", TOKEN_A, { dailyTarget: 99 })).status).toBe(400);
    expect((await call("PATCH", "/facts/not-a-uuid", TOKEN_A, {})).status).toBe(400);
  });

  it("editing a verified fact's text un-verifies it", async () => {
    const [fact] = (await json(await call("GET", "/facts", TOKEN_A))).items as Array<{ id: string; text: string }>;
    const r = await json(await call("PATCH", `/facts/${fact!.id}`, TOKEN_A, { text: `${fact!.text} (2018-2024)` }));
    expect(r.fact.verified).toBe(false);
    await call("PATCH", `/facts/${fact!.id}`, TOKEN_A, { verified: true });
  });

  it("finds companies in the catalog and blocks one", async () => {
    const found = (await json(await call("GET", "/companies?q=glob", TOKEN_A))).items as Array<{ id: string; name: string }>;
    expect(found.map((c) => c.name)).toEqual(["Globex"]);
    expect((await call("PUT", `/companies/${found[0]!.id}/preference`, TOKEN_A, { blockMode: "hard", reason: "Not interested" })).status).toBe(200);
  });
});

describe("P3 daily queue", () => {
  it("builds the queue from the real tables and records every exclusion with its reason", async () => {
    const built = await json(await call("POST", "/queue/build", TOKEN_A));
    expect(built).toMatchObject({ queued: 1, excluded: 3 });

    const queue = (await json(await call("GET", "/queue", TOKEN_A))).items as Array<Record<string, unknown>>;
    expect(queue.map((q) => q.company)).toEqual(["Acme"]);
    expect(queue[0]).toMatchObject({ state: "queued", gate_verdict: "PASS" });

    const run = await json(await call("GET", `/queue/runs/${built.date}`, TOKEN_A));
    const reasons = (run.excluded as Array<{ reason: string }>).map((e) => e.reason).join(" | ");
    expect(reasons).toMatch(/german/i); // language gate
    expect(reasons).toMatch(/Not interested/); // blacklist
    expect(reasons).toMatch(/sponsorship/); // posting says it will not sponsor
  });

  it("is idempotent: building again the same day adds nothing", async () => {
    await call("POST", "/queue/build", TOKEN_A);
    const queue = (await json(await call("GET", "/queue", TOKEN_A))).items as unknown[];
    expect(queue).toHaveLength(1);
  });

  it("moves an application through the state machine and logs each change", async () => {
    const [item] = (await json(await call("GET", "/queue", TOKEN_A))).items as Array<{ id: string }>;
    expect((await call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "offer" })).status).toBe(409);
    expect((await call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "approved" })).status).toBe(200);
    expect((await call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "submitted", note: "via copy-assist" })).status).toBe(200);
    expect((await call("POST", `/applications/${item!.id}/status`, TOKEN_B, { state: "withdrawn" })).status).toBe(404);
    const events = await pg.query<{ payload: { from: string; to: string } }>(
      "SELECT payload FROM mca.application_event WHERE application_id = $1 ORDER BY id", [item!.id]);
    expect(events.rows.map((e) => `${e.payload.from}>${e.payload.to}`)).toEqual(["queued>approved", "approved>submitted"]);
    expect((await json(await call("GET", "/queue", TOKEN_A))).items).toEqual([]); // submitted leaves the queue
  });

  it("keeps users apart: another user sees no profile, queue or runs", async () => {
    expect((await call("GET", "/profile", TOKEN_B)).status).toBe(404);
    expect((await json(await call("GET", "/queue", TOKEN_B))).items).toEqual([]);
    expect((await call("POST", "/queue/build", TOKEN_B)).status).toBe(409);
  });

  it("lists users for the nightly job without exposing their data", async () => {
    const res = await pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE mca_app");
      return tx.query<{ user_id: string }>("SELECT mca.users_for_queue() AS user_id");
    });
    expect(res.rows.map((r) => r.user_id)).toEqual(["alice"]);
  });
});
