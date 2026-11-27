// freehire reader: files jobs under their own employers, skips LinkedIn-sourced jobs and boards the
// app already reads, and stops on a 429.
import { describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { parseFreehire, runFreehire } from "../src/freehire.js";
import type { Sql } from "../src/lib/db.js";
import { harness } from "./harness.js";

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

const job = (slug: string, company: string, source: string, extra: Record<string, unknown> = {}) => ({
  public_slug: slug, title: "Senior Software Engineer", company, source, url: `https://src.example/${slug}`, location: "Austin, Texas",
  countries: ["us"], description: "<p>Go and Kubernetes. $150,000 - $180,000 a year</p>", posted_at: "2026-11-25T00:00:00Z", closed_at: null, ...extra });

describe("freehire", () => {
  it("names the country in the place text and keeps the original posting link", () => {
    const p = parseFreehire(job("a", "NVIDIA", "workday"))!;
    expect(p).toMatchObject({ company: "NVIDIA", country: "US", job: { atsVendor: "freehire", atsJobId: "a", locationText: "Austin, Texas, United States", applyUrl: "https://src.example/a" } });
    expect(parseFreehire(job("b", "X", "workday", { closed_at: "2026-11-20T00:00:00Z" }))).toBeNull();
  });

  it("stores jobs under their employers and skips LinkedIn-sourced and directly-read ones", async () => {
    const h = await harness();
    h.env.TEST_INGEST_SQL = ingestSql(h.pg);
    await h.pg.query(`INSERT INTO mca.company (name, name_norm, ats_vendor, ats_board) VALUES ('Stripe', 'STRIPE', 'greenhouse', 'stripe')`);
    let calls = 0;
    const f = (async (url: string) => {
      calls++;
      const u = new URL(url);
      if (u.searchParams.get("category") === "backend") return new Response("", { status: 429 });
      if (u.searchParams.get("category") !== "software_engineering") return new Response(JSON.stringify({ data: [] }));
      return new Response(JSON.stringify({ data: [job("n1", "NVIDIA Corporation", "workday"), job("n2", "NVIDIA", "workday"), job("s1", "Stripe", "greenhouse"), job("l1", "Acme", "linkedin")] }));
    }) as unknown as typeof fetch;
    const r = await runFreehire(h.env, { fetcher: f, gapMs: 0, countries: ["us"], categories: ["software_engineering", "backend", "frontend"] });
    expect(r).toMatchObject({ stored: 2, skippedLinkedIn: 1, skippedDirect: 1, newCompanies: 1 });
    expect(r.stoppedEarly).toContain("429");
    expect(calls).toBe(2); // stopped at the 429, frontend never asked
    const rows = (await h.pg.query(`SELECT c.name, c.source, j.country FROM mca.job j JOIN mca.company c ON c.id = j.company_id WHERE j.ats_vendor = 'freehire'`)).rows;
    expect(rows).toEqual([{ name: "NVIDIA Corporation", source: "freehire", country: "US" }, { name: "NVIDIA Corporation", source: "freehire", country: "US" }]);
  });
});
