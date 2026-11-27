// Company discovery: board-name guesses, the same-company check, and an end-to-end run that adds a
// verified board, links its sponsor records, remembers misses, and leaves look-alikes alone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverCompanies, findBoard, sameCompany, slugsFor } from "../src/discover.js";
import { harness } from "./harness.js";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../src/lib/db.js";

afterEach(() => vi.unstubAllGlobals());
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("board name guesses", () => {
  it("tries the full name first, then without filler words, then a distinctive first word", () => {
    expect(slugsFor("ROBINHOOD MARKETS, INC.").map((s) => s.slug)).toEqual(["robinhoodmarkets", "robinhood-markets", "robinhood"]);
    expect(slugsFor("Databricks Inc").map((s) => s.slug)).toEqual(["databricks"]);
    expect(slugsFor("Snowflake Technologies Inc").map((s) => s.slug)).toEqual(["snowflaketechnologies", "snowflake-technologies", "snowflake"]);
    expect(slugsFor("GENERAL MOTORS LLC").find((s) => s.slug === "general")).toBeUndefined(); // too generic alone
    expect(slugsFor("ROBINHOOD MARKETS, INC.").find((s) => s.slug === "robinhood")!.full).toBe(false);
  });
  it("matches a board's own name to the employer", () => {
    expect(sameCompany("Robinhood", "ROBINHOOD MARKETS INC")).toBe(true);
    expect(sameCompany("Stripe", "STRIPE, INC.")).toBe(true);
    expect(sameCompany("Datadog", "DATABRICKS INC")).toBe(false);
    expect(sameCompany("Ace", "ACE HARDWARE CORPORATION")).toBe(false); // too short to trust
  });
});

/** Fake job-board systems: Greenhouse knows "robinhood" (name Robinhood) and "general" (a different company). */
function systems(calls: string[]) {
  return (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === "boards-api.greenhouse.io") {
      const slug = u.pathname.split("/")[3];
      const boards: Record<string, string> = { robinhood: "Robinhood", general: "General Assembly" };
      if (!boards[slug!]) return json({ status: 404 }, 404);
      return u.pathname.endsWith("/jobs") ? json({ jobs: [{ id: 1 }, { id: 2 }] }) : json({ name: boards[slug!] });
    }
    if (u.host === "api.lever.co" && u.pathname.endsWith("/acmeanalytics")) return json([{ id: "a" }]);
    if (u.host === "api.smartrecruiters.com") return json({ totalFound: 0, content: [] }); // unknown ids answer "0 jobs"
    return json({}, 404);
  }) as unknown as typeof fetch;
}

describe("finding one employer's board", () => {
  it("accepts a named board only when the name matches", async () => {
    const calls: string[] = [];
    expect((await findBoard("ROBINHOOD MARKETS, INC.", systems(calls))).hit).toMatchObject({ vendor: "greenhouse", board: "robinhood", name: "Robinhood" });
    expect((await findBoard("GENERAL MOTORS LLC", systems([]))).hit).toBeNull();
  });
  it("trusts an unnamed board only under the employer's full name", async () => {
    expect((await findBoard("Acme Analytics LLC", systems([]))).hit).toMatchObject({ vendor: "lever", board: "acmeanalytics" });
    expect((await findBoard("Acme Analytics Holdings Corp", systems([]))).hit).toMatchObject({ board: "acmeanalytics" }); // "Holdings" is filler
    expect((await findBoard("Acme Analytics Partners Corp", systems([]))).hit).toBeNull(); // a different name: not trusted unnamed
  });
});

function ingestSql(pg: PGlite): Sql {
  type Q = { text: string; params: unknown[] };
  const run = (qs: Q[]) => pg.transaction(async (tx) => {
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

describe("discovery run", () => {
  it("adds verified boards, links sponsor records, remembers misses, and skips them next time", async () => {
    const h = await harness();
    h.env.TEST_INGEST_SQL = ingestSql(h.pg);
    for (const [name, norm, filings] of [["ROBINHOOD MARKETS, INC.", "ROBINHOOD MARKETS", 300], ["GENERAL MOTORS LLC", "GENERAL MOTORS", 900], ["ACME ANALYTICS LLC", "ACME ANALYTICS", 40]] as const)
      await h.pg.query(`INSERT INTO mca.sponsor_record (country, source, occupation_code, employer_name, employer_norm, filings, certified, period_end) VALUES ('US', 'dol_lca', '15-1252', $1, $2, $3, $3, '2026-09-30')`, [name, norm, filings]);
    const calls: string[] = [];
    const r = await discoverCompanies(h.env, { fetcher: systems(calls), gapMs: 0 });
    expect(r).toMatchObject({ checked: 3, found: 2, stoppedEarly: false });
    const { rows } = await h.pg.query<{ name: string; ats_vendor: string; ats_board: string; aliases: string[]; source: string }>(
      "SELECT name, ats_vendor, ats_board, aliases, source FROM mca.company WHERE source = 'discovered' ORDER BY name");
    expect(rows).toEqual([
      { name: "Acme Analytics", ats_vendor: "lever", ats_board: "acmeanalytics", aliases: [], source: "discovered" },
      { name: "Robinhood", ats_vendor: "greenhouse", ats_board: "robinhood", aliases: ["ROBINHOOD MARKETS"], source: "discovered" },
    ]);
    const { rows: linked } = await h.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mca.sponsor_record WHERE company_id IS NOT NULL");
    expect(linked[0]!.n).toBe(2);
    // Second run: nothing left to check (GM was a miss, remembered).
    calls.length = 0;
    expect(await discoverCompanies(h.env, { fetcher: systems(calls), gapMs: 0 })).toMatchObject({ checked: 0 });
    expect(calls).toEqual([]);
  });

  it("rests only the system that says slow down, and keeps asking the others", async () => {
    const h = await harness();
    h.env.TEST_INGEST_SQL = ingestSql(h.pg);
    await h.pg.query(`INSERT INTO mca.sponsor_record (country, source, occupation_code, employer_name, employer_norm, filings, certified, period_end) VALUES ('US', 'dol_lca', '15-1252', 'ACME ANALYTICS LLC', 'ACME ANALYTICS', 50, 50, '2026-09-30')`);
    const calls: string[] = [];
    const base = systems(calls);
    const fetcher = (async (url: string) => (new URL(url).host === "boards-api.greenhouse.io" ? new Response("", { status: 429 }) : base(url))) as unknown as typeof fetch;
    const r = await discoverCompanies(h.env, { fetcher, gapMs: 0 });
    expect(r).toMatchObject({ found: 1, resting: ["greenhouse"] }); // Lever still found Acme
  });

  it("stops politely when a system says it's rate-limiting", async () => {
    const h = await harness();
    h.env.TEST_INGEST_SQL = ingestSql(h.pg);
    await h.pg.query(`INSERT INTO mca.sponsor_record (country, source, occupation_code, employer_name, employer_norm, filings, certified, period_end) VALUES ('US', 'dol_lca', '15-1252', 'ZETA LABS INC', 'ZETA LABS', 50, 50, '2026-09-30')`);
    const r = await discoverCompanies(h.env, { fetcher: (async () => new Response("", { status: 429 })) as unknown as typeof fetch, gapMs: 0 });
    expect(r).toMatchObject({ unfinished: 1, found: 0 });
    const { rows } = await h.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mca.board_discovery");
    expect(rows[0]!.n).toBe(0); // not marked as a miss: it'll be checked again
  });
});
