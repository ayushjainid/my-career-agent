// Beta loop B5: offer timing from stage history, pay benchmarks on queue and packet.
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let acme: { companyId: string; jobId: string };

beforeAll(async () => {
  h = await harness();
  acme = await h.addCompany("Acme");
  await h.addCompany("Globex");
  await h.pg.query(
    `INSERT INTO mca.pay_benchmark (country, employer_norm, company_id, title_family, n, p25, p50, p75, currency, source_file, period_end)
     VALUES ('US', 'ACME', $1, 'data engineer', 12, 150000, 170000, 190000, 'USD', 'lca.xlsx', '2026-06-30'),
            ('US', '*', NULL, 'data engineer', 900, 120000, 145000, 175000, 'USD', 'lca.xlsx', '2026-06-30')`, [acme.companyId]);
  await h.setupProfile(TOKEN_A);
  await h.call("POST", "/queue/build", TOKEN_A);
});

describe("pay benchmarks", () => {
  it("prefer the company's own filings, else the market, on queue rows and the packet", async () => {
    const q = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items as Array<{ company: string; pay_benchmark: { scope: string; p50: number } | null }>;
    expect(q.find((i) => i.company === "Acme")!.pay_benchmark).toMatchObject({ scope: "company", p50: 170000 });
    expect(q.find((i) => i.company === "Globex")!.pay_benchmark).toMatchObject({ scope: "market", p50: 145000 });
    const p = await h.json(await h.call("GET", `/packets/${acme.jobId}`, TOKEN_A));
    expect(p.payBenchmark).toMatchObject({ scope: "company", n: 12, p25: 150000, p75: 190000 });
  });
});

describe("timing", () => {
  it("estimates offers for live processes from defaults until there is history", async () => {
    const items = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items as Array<{ id: string; company: string }>;
    for (const it of items) {
      await h.call("POST", `/applications/${it.id}/status`, TOKEN_A, { state: "approved" });
      await h.call("POST", `/applications/${it.id}/status`, TOKEN_A, { state: "submitted" });
    }
    await h.call("POST", `/applications/${items[0]!.id}/status`, TOKEN_A, { state: "screen" });
    const t = await h.json(await h.call("GET", "/timing", TOKEN_A));
    expect(t.basis).toEqual({ toScreen: "default", screenToInterview: "default", interviewToOffer: "default" });
    expect(t.timeToOfferDays).toBe(36);
    expect(t.estimates).toHaveLength(2);
    expect(t.estimates[0]).toMatchObject({ state: "screen", basis: "default" });
    expect(t.window).toMatchObject({ source: "estimated" });
  });

  it("uses the person's chosen window when set", async () => {
    await h.call("PUT", "/profile", TOKEN_A, { offerWindowStart: "2027-01-15" });
    const t = await h.json(await h.call("GET", "/timing", TOKEN_A));
    expect(t.window).toMatchObject({ start: "2027-01-05", end: "2027-01-25", source: "yours" });
  });
});
