// Job fetching (run by the GitHub job) under the catalog-only ingest role, and the Today page's
// "Build today's queue", which starts that job and then watches for the new queue.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../src/lib/db.js";
import { runIngest } from "../src/ingest.js";
import { runAllQueues } from "../src/queue.js";
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

const fetchNow = (limit = 1, staleAfterMinutes = 60) => runIngest(h.env, { limit, staleAfterMinutes });

describe("Fetching job boards", () => {
  it("starts with nothing to queue", async () => {
    const r = await h.json(await h.call("POST", "/queue/build", TOKEN_A));
    expect(r.queued).toBe(0);
    expect(r.note).toMatch(/no open jobs/);
  });

  it("claims boards oldest first until none are stale, stores posting signals, and queues build from them", async () => {
    stubBoards();
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await fetchNow());
    expect(runs.map((c) => c.boards)).toEqual([1, 1, 1, 0]);
    expect(runs.map((c) => c.remaining)).toEqual([2, 1, 0, 0]);
    expect(runs[0]).toMatchObject({ total: 3, added: 1 });
    expect(fetched.sort()).toEqual(["alpha", "bravo", "charlie"]);
    const { rows } = await h.pg.query<{ r: { signals?: unknown } }>("SELECT requirements AS r FROM mca.job LIMIT 1");
    expect(rows[0]!.r.signals).toMatchObject({ languages: [], citizenOnly: null });

    const [res] = await runAllQueues(h.env, h.env.TEST_DB!, ["alice"]);
    expect(res).toMatchObject({ user: "alice", queued: 3 });
  });

  it("does not fetch a board again within the hour", async () => {
    stubBoards();
    expect(await fetchNow()).toMatchObject({ boards: 0, remaining: 0 });
    expect(fetched).toEqual([]);
  });

  it("the scheduled run (stale 0) fetches every board in one pass", async () => {
    stubBoards();
    expect(await fetchNow(1000, 0)).toMatchObject({ boards: 3 });
    expect(fetched.sort()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("a failing board is reported and the rest carry on", async () => {
    await h.pg.query("UPDATE mca.company SET last_fetched_at = now() - interval '2 hours'");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("/alpha/") ? new Response("down", { status: 500 }) : new Response(JSON.stringify(board("x")), { status: 200 }));
    const r = await fetchNow(1000, 60);
    expect(r.boards).toBe(3);
    expect(r.errors).toHaveLength(1);
  });
});

describe("Build today's queue (starts the GitHub job)", () => {
  it("says plainly when on-demand fetching isn't set up", async () => {
    const r = await h.call("POST", "/queue/refresh", TOKEN_A);
    expect(r.status).toBe(503);
    expect((await h.json(r)).error).toMatch(/GH_DISPATCH_TOKEN/);
  });

  it("starts jobs.yml for this user, then joins that run instead of starting another", async () => {
    h.env.GITHUB_DISPATCH_TOKEN = "github_pat_test";
    h.env.GITHUB_REPO = "owner/repo";
    let sent: { url: string; auth: string; body: { ref: string; inputs: { user_id: string } } } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent = { url, auth: init.headers.authorization!, body: JSON.parse(init.body) };
      return new Response(null, { status: 204 });
    });
    const r = await h.json(await h.call("POST", "/queue/refresh", TOKEN_A));
    expect(r.started).toBe(true);
    expect(sent!.url).toBe("https://api.github.com/repos/owner/repo/actions/workflows/jobs.yml/dispatches");
    expect(sent!.auth).toBe("Bearer github_pat_test");
    expect(sent!.body).toEqual({ ref: "main", inputs: { user_id: "alice" } });

    sent = null;
    const again = await h.json(await h.call("POST", "/queue/refresh", TOKEN_A));
    expect(again.started).toBe(false);
    expect(sent).toBeNull();
  });

  it("reports progress: not done until a queue run newer than the request exists", async () => {
    const before = await h.json(await h.call("GET", "/queue/refresh", TOKEN_A));
    expect(before.done).toBe(false);
    await runAllQueues(h.env, h.env.TEST_DB!, ["alice"]);
    const after = await h.json(await h.call("GET", "/queue/refresh", TOKEN_A));
    expect(after.done).toBe(true);
    expect(after.run).toMatchObject({ queued: expect.any(Number), excluded: expect.any(Number) });
  });

  it("explains a GitHub refusal", async () => {
    await h.pg.query("UPDATE mca.app_user SET queue_requested_at = now() - interval '1 hour'");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    const r = await h.call("POST", "/queue/refresh", TOKEN_A);
    expect(r.status).toBe(502);
    expect((await h.json(r)).error).toMatch(/HTTP 401/);
  });

  it("needs a signed-in user", async () => {
    expect((await h.call("POST", "/queue/refresh", null)).status).toBe(401);
  });
});
