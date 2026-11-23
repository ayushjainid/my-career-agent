// Beta loop B7: a UK job judged by the UK sponsor register; jobs outside target countries excluded.
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
  const mk = async (name: string, country: string, location: string) => {
    const { companyId, jobId } = await h.addCompany(name);
    await h.pg.query("UPDATE mca.job SET country = $2, location_text = $3, pay_currency = $4 WHERE id = $1", [jobId, country, location, country === "GB" ? "GBP" : "USD"]);
    await h.pg.query("DELETE FROM mca.sponsor_record WHERE company_id = $1", [companyId]);
    return companyId;
  };
  const monzo = await mk("Monzo", "GB", "London, UK");
  await mk("Revolut", "GB", "London, UK");
  await mk("Shopify", "CA", "Toronto, ON");
  await h.pg.query(`INSERT INTO mca.sponsor_record (company_id, country, source, employer_name, employer_norm, filings, certified, extra)
                    VALUES ($1, 'GB', 'ukvi_register', 'Monzo Bank Ltd', 'MONZO BANK', 1, 1, '{"route":"Skilled Worker","rating":"A"}')`, [monzo]);
  await h.call("PUT", "/profile", TOKEN_A, { homeCountry: "IN" });
  await h.call("POST", "/facts", TOKEN_A, [{ kind: "role", text: "Data engineer", skills: ["python", "sql", "aws"], startDate: "2018-01-01", verified: true }]);
  await h.call("PUT", "/languages", TOKEN_A, [{ language: "English", level: "C2" }]);
  await h.call("PUT", "/work-auth/uk", TOKEN_A, { status: "needs_sponsorship" });
  await h.call("POST", "/targets", TOKEN_A, { country: "UK", title: "Data Engineer" });
});

describe("UK pack", () => {
  it("stores UK as GB with register-based defaults", async () => {
    const p = await h.json(await h.call("GET", "/profile", TOKEN_A));
    expect(p.workAuth[0]).toMatchObject({ country: "GB", min_lca_filings: 1, min_perm_certified: 0 });
    expect(p.targets[0].country).toBe("GB");
  });

  it("queues licensed sponsors, excludes unlicensed ones and jobs outside target countries", async () => {
    const r = await h.json(await h.call("POST", "/queue/build", TOKEN_A));
    const q = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items.map((i: { company: string }) => i.company);
    expect(q).toEqual(["Monzo"]);
    const run = await h.json(await h.call("GET", `/queue/runs/${r.date}`, TOKEN_A));
    const reasons = run.excluded.map((e: { reason: string }) => e.reason).join(" | ");
    expect(reasons).toMatch(/Located in CA; your target roles are in GB/);
    expect(reasons).toMatch(/sponsor/i); // Revolut is not on the register in this test
  });
});
