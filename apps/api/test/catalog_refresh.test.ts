// On-demand job fetch from the Today page: one board per call, never the same board twice in an hour,
// run as the catalog-only ingest role, then the queue builds from what came in.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../src/lib/db.js";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let fetched: string[] = [];

/** A neon-style tagged-template client over PGlite, running as mca_ingest like production. */
function ingestSql(pg: PGlite): Sql {
  type Q = { text: string; params: unknown[] };
  const run = (qs: Q[]) =>
    pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE mca_ingest");
      const out: unknown[][] = [];
      for (const q of qs) out.push((await tx.query(q.text, q.params)).rows);
      return out;
    });
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q: Q = { text: strings.reduce((a, s, i) => a + `$${i}` + s), params: vals };
    return { ...q, then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => run([q]).then((r) => r[0]).then(ok, bad) };
  };
  return Object.assign(tag, { transaction: (qs: Q[]) => run(qs) }) as unknown as Sql;
}

const board = (name: string) => ({
  jobs: [{
    id: 1, title: "Senior Data Engineer", location: { name: "New York, NY" },
    absolute_url: `https://boards.greenhouse.io/${name}/jobs/1`, updated_at: "2026-11-24T10:00:00Z",
    content: "<p>Requirements</p><ul><li>5+ years of Python</li><li>SQL</li><li>AWS</li></ul>",
  }],
  meta: { total: 1 },
});

beforeAll(async () => {
  h = await harness();
  h.env.TEST_INGEST_SQL = ingestSql(h.pg);
  for (const n of ["alpha", "bravo", "charlie"]) {
    const { rows } = await h.pg.query<{ id: string }>(
      "INSERT INTO mca.company (name, name_norm, ats_vendor, ats_board) VALUES ($1, upper($1), 'greenhouse', $1) RETURNING id", [n]);
    await h.pg.query(
      `INSERT INTO mca.sponsor_record (company_id, country, source, employer_name, employer_norm, filings, certified, period_end)
       VALUES ($1, 'US', 'dol_lca', $2, upper($2), 50, 0, '2026-09-30'), ($1, 'US', 'dol_perm', $2, upper($2), 0, 10, '2026-09-30')`, [rows[0]!.id, n]);
  }
  await h.setupProfile(TOKEN_A);
});

afterEach(() => vi.unstubAllGlobals());

const stubBoards = () => {
  fetched = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const name = /boards\/([^/]+)\/jobs/.exec(url)![1]!;
    fetched.push(name);
    return new Response(JSON.stringify(board(name)), { status: 200 });
  });
};

describe("Fetch jobs now", () => {
  it("starts with nothing to queue", async () => {
    const r = await h.json(await h.call("POST", "/queue/build", TOKEN_A));
    expect(r.queued).toBe(0);
    expect(r.note).toMatch(/no open jobs/);
  });

  it("fetches one board per call until none are left, then the queue builds", async () => {
    stubBoards();
    const calls = [];
    for (let i = 0; i < 4; i++) calls.push(await h.json(await h.call("POST", "/catalog/refresh", TOKEN_A)));
    expect(calls.map((c) => c.boards)).toEqual([1, 1, 1, 0]);
    expect(calls.map((c) => c.remaining)).toEqual([2, 1, 0, 0]);
    expect(calls[0]).toMatchObject({ total: 3, added: 1, failed: 0 });
    expect(fetched.sort()).toEqual(["alpha", "bravo", "charlie"]);

    const r = await h.json(await h.call("POST", "/queue/build", TOKEN_A));
    expect(r.queued).toBe(3);
  });

  it("does not fetch a board again within the hour", async () => {
    stubBoards();
    const r = await h.json(await h.call("POST", "/catalog/refresh", TOKEN_A));
    expect(r).toMatchObject({ boards: 0, remaining: 0 });
    expect(fetched).toEqual([]);
  });

  it("parallel calls never fetch the same board twice", async () => {
    await h.pg.query("UPDATE mca.company SET last_fetched_at = now() - interval '2 hours'");
    stubBoards();
    await Promise.all([1, 2, 3].map(() => h.call("POST", "/catalog/refresh", TOKEN_A)));
    expect(fetched.sort()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("a failing board is reported, skipped for the hour, and the rest carry on", async () => {
    await h.pg.query("UPDATE mca.company SET last_fetched_at = now() - interval '2 hours'");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("/alpha/") ? new Response("down", { status: 500 }) : new Response(JSON.stringify(board("x")), { status: 200 }));
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await h.json(await h.call("POST", "/catalog/refresh", TOKEN_A)));
    expect(rs.reduce((n, r) => n + r.failed, 0)).toBe(1);
    expect(rs.at(-1)).toMatchObject({ boards: 0, remaining: 0 });
  });

  it("needs a signed-in user", async () => {
    expect((await h.call("POST", "/catalog/refresh", null)).status).toBe(401);
  });
});
