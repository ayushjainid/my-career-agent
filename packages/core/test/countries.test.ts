import { describe, expect, it } from "vitest";
import { inferCountry, normalizeCountry, sponsorshipFor } from "../src/index.js";

describe("country packs (B7)", () => {
  it("infers the country from a job location", () => {
    expect(inferCountry("London, England, United Kingdom")).toBe("GB");
    expect(inferCountry("Remote - UK")).toBe("GB");
    expect(inferCountry("Toronto, ON")).toBe("CA");
    expect(inferCountry("Vancouver, British Columbia, Canada")).toBe("CA");
    expect(inferCountry("New York, NY")).toBe("US");
    expect(inferCountry("Remote (US)")).toBe("US");
    expect(inferCountry("Berlin, Germany")).toBe("DE");
    expect(inferCountry("Remote")).toBeNull();
    expect(inferCountry("Portland, OR")).toBe("US");
    expect(normalizeCountry("uk")).toBe("GB");
  });

  it("scores sponsorship by each country's public evidence", () => {
    const t = { minFilings: 1, minPermCertified: 0 };
    const base = { filings: 1, permCertified: 0, permDenied: 0, lastFilingDate: null };
    expect(sponsorshipFor("GB", { ...base, rating: "A (Premium)" }, t, "none")).toMatchObject({ passes: true, score: 0.85 });
    expect(sponsorshipFor("GB", null, t, "none")).toMatchObject({ passes: false });
    expect(sponsorshipFor("CA", { ...base, filings: 12 }, t, "none")).toMatchObject({ passes: true, score: 1 });
    expect(sponsorshipFor("CA", null, t, "positive")).toMatchObject({ passes: true, score: 0.4 });
    expect(sponsorshipFor("GB", { ...base, rating: "A" }, t, "negative").passes).toBe(false);
  });
});
