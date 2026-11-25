// Workday, SmartRecruiters, Workable and Recruitee: parsing, paging, the tech-title filter on huge
// boards, "already stored" jobs that aren't re-read, and never closing jobs from an incomplete list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAny } from "../src/ats/adapters.js";
import { fetchSmartRecruiters, fetchWorkday, parseRecruitee, parseWorkable, TECH_TITLE, workdayParts } from "../src/ats/more.js";
import { runIngest } from "../src/ingest.js";
import { harness } from "./harness.js";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../src/lib/db.js";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** A Workday tenant with `n` postings, every third one non-tech; records the requests made. */
function workday(n: number, calls: string[]) {
  const posts = Array.from({ length: n }, (_, i) => ({
    title: i % 3 === 2 ? `Store Associate ${i}` : `Senior Software Engineer ${i}`,
    externalPath: `/job/Austin-TX/Role_JR${1000 + i}`,
    locationsText: "Austin, TX",
    postedOn: "Posted Today",
  }));
  return (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/jobs") && init?.method === "POST") {
      const { offset, limit } = JSON.parse(init.body!);
      return json({ total: n, jobPostings: posts.slice(offset, offset + limit) });
    }
    const path = url.split("/External")[1]!;
    const p = posts.find((x) => x.externalPath === path)!;
    return json({ jobPostingInfo: { title: p.title, jobReqId: path.split("_")[1], location: "Austin, TX", startDate: "2026-11-20",
      externalUrl: `https://acme.wd5.myworkdayjobs.com/en-US/External${path}`,
      jobDescription: "<p>Requirements</p><ul><li>5+ years of Python</li><li>SQL</li></ul><p>Pay range: $150,000 - $190,000 per year</p>" } });
  }) as unknown as typeof fetch;
}

describe("Workday", () => {
  it("reads the board address", () => {
    expect(workdayParts("nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite")).toEqual({ host: "nvidia.wd5.myworkdayjobs.com", tenant: "nvidia", site: "NVIDIAExternalCareerSite" });
    expect(workdayParts("https://acme.wd1.myworkdayjobs.com/en-US/Careers/")).toMatchObject({ tenant: "acme", site: "Careers" });
    expect(workdayParts("acme.com/careers")).toBeNull();
  });

  it("pages the listing, fetches details only for tech titles, and reads pay from the text", async () => {
    const calls: string[] = [];
    const r = await fetchWorkday("acme.wd5.myworkdayjobs.com/External", { fetcher: workday(45, calls) });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(3); // 20 + 20 + 5
    expect(r.jobs).toHaveLength(30); // 15 store roles skipped
    expect(r.complete).toBe(true);
    const j = r.jobs[0]!;
    expect(j).toMatchObject({ atsVendor: "workday", atsJobId: "/job/Austin-TX/Role_JR1000", title: "Senior Software Engineer 0", locationText: "Austin, TX",
      postedAt: "2026-11-20T00:00:00.000Z", applyUrl: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Role_JR1000" });
    expect(j.pay).toMatchObject({ min: 150000, max: 190000, period: "year" });
    expect(j.descriptionText).toContain("5+ years of Python");
  });

  it("doesn't re-read jobs it already has, and caps new detail requests per run", async () => {
    const calls: string[] = [];
    const known = new Set(["/job/Austin-TX/Role_JR1000", "/job/Austin-TX/Role_JR1001"]);
    const r = await fetchWorkday("acme.wd5.myworkdayjobs.com/External", { fetcher: workday(45, calls), known, maxDetails: 10 });
    expect(r.touch).toEqual([...known]);
    expect(r.jobs).toHaveLength(10);
    expect(calls.some((c) => c.endsWith("Role_JR1000"))).toBe(false);
    expect(r.complete).toBe(false); // more new jobs than the cap: nothing may be closed
  });

  it("an unfinished listing is marked incomplete", async () => {
    const r = await fetchWorkday("acme.wd5.myworkdayjobs.com/External", { fetcher: workday(100, []), maxPages: 2 });
    expect(r.complete).toBe(false);
  });

  it("knows which titles are tech roles", () => {
    for (const t of ["Staff Data Engineer", "ML Scientist", "Site Reliability Engineer", "Product Manager, Payments", "iOS Developer"]) expect(TECH_TITLE.test(t)).toBe(true);
    for (const t of ["Store Associate", "Pharmacist", "Truck Driver", "Cashier"]) expect(TECH_TITLE.test(t)).toBe(false);
  });
});

describe("SmartRecruiters", () => {
  it("pages postings and reads each tech posting's sections", async () => {
    const list = Array.from({ length: 130 }, (_, i) => ({ id: String(500 + i), name: i % 2 ? "Backend Developer" : "Warehouse Operative" }));
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/postings")) {
        const off = Number(u.searchParams.get("offset"));
        return json({ totalFound: 130, content: list.slice(off, off + 100) });
      }
      const id = u.pathname.split("/").pop();
      return json({ id, name: "Backend Developer", releasedDate: "2026-11-18T09:00:00.000Z", location: { city: "Milano", country: "it", remote: false },
        applyUrl: `https://jobs.smartrecruiters.com/Acme/${id}`,
        jobAd: { sections: { jobDescription: { text: "<p>Build services in Java.</p>" }, qualifications: { text: "<ul><li>Almeno 5 anni di esperienza</li></ul>" } } } });
    }) as unknown as typeof fetch;
    const r = await fetchSmartRecruiters("Acme", { fetcher });
    expect(calls.filter((c) => c.includes("/postings?"))).toHaveLength(2);
    expect(r.jobs).toHaveLength(65);
    expect(r.jobs[0]).toMatchObject({ atsVendor: "smartrecruiters", title: "Backend Developer", locationText: "Milano, IT", remoteType: "unknown" });
    expect(r.jobs[0]!.descriptionText).toMatch(/Java[\s\S]*Almeno 5 anni/);
    expect(r.complete).toBe(true);
  });
});

describe("Workable and Recruitee", () => {
  it("Workable: one request with descriptions", () => {
    const jobs = parseWorkable({ name: "Acme", jobs: [
      { title: "Data Engineer", shortcode: "AB12CD", telecommuting: false, published_on: "2026-11-15", application_url: "https://apply.workable.com/acme/j/AB12CD/apply",
        locations: [{ city: "Milan", region: "Lombardy", country: "Italy", hidden: false }], description: "<p>Requisiti: Python, SQL. RAL 45.000 - 55.000 €</p>" },
      { title: "Hidden role" },
    ] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ atsVendor: "workable", atsJobId: "AB12CD", locationText: "Milan, Lombardy, Italy", postedAt: "2026-11-15T00:00:00.000Z" });
    expect(jobs[0]!.pay).toMatchObject({ min: 45000, max: 55000, currency: "EUR" });
  });

  it("Recruitee: offers with structured pay and workplace flags", () => {
    const jobs = parseRecruitee({ offers: [
      { id: 77, title: "Frontend Engineer", status: "published", location: "Milano, Italy", hybrid: true, published_at: "2026-11-10 08:00:00 UTC",
        careers_apply_url: "https://acme.recruitee.com/o/frontend-engineer/c/new", description: "<p>React</p>", requirements: "<p>3+ anni</p>",
        salary: { min: "40000", max: "50000", currency: "EUR", period: "year" } },
      { id: 78, title: "Closed", status: "closed" },
    ] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ atsJobId: "77", remoteType: "hybrid", postedAt: "2026-11-10T08:00:00.000Z", pay: { min: 40000, max: 50000, currency: "EUR", source: "structured" } });
  });

  it("a removed board is reported as not found, not as zero jobs", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(fetchAny({ vendor: "recruitee", board: "gone" })).rejects.toThrow(/not found/);
  });
});

/** A neon-style client over PGlite, as in catalog_refresh.test.ts. */
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

describe("ingesting a Workday board", () => {
  it("stores tech jobs, touches known ones, and never closes from an incomplete listing", async () => {
    const h = await harness();
    h.env.TEST_INGEST_SQL = ingestSql(h.pg);
    await h.pg.query("INSERT INTO mca.company (name, name_norm, ats_vendor, ats_board) VALUES ('Acme', 'ACME', 'workday', 'acme.wd5.myworkdayjobs.com/External')");
    const calls: string[] = [];
    vi.stubGlobal("fetch", workday(45, calls));
    const r1 = await runIngest(h.env, { limit: 10 });
    expect(r1).toMatchObject({ boards: 1, added: 30, errors: [] });

    // Next run: everything known is touched, not re-read.
    calls.length = 0;
    await h.pg.query("UPDATE mca.company SET last_fetched_at = now() - interval '2 hours'");
    const r2 = await runIngest(h.env, { limit: 10 });
    expect(r2).toMatchObject({ added: 0, updated: 30, closed: 0 });
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(0);

    // A run that can't read the whole list closes nothing, even though jobs are "missing".
    await h.pg.query("UPDATE mca.company SET last_fetched_at = now() - interval '2 hours'");
    vi.stubGlobal("fetch", (async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") { const { offset } = JSON.parse(init.body!); return json({ total: 45, jobPostings: offset === 0 ? [] : [] }); }
      return json({});
    }) as unknown as typeof fetch);
    const r3 = await runIngest(h.env, { limit: 10 });
    expect(r3.closed).toBe(0);
    const { rows } = await h.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mca.job WHERE status = 'open'");
    expect(rows[0]!.n).toBe(30);
  });
});
