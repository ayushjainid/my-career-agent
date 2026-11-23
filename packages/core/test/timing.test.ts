import { describe, expect, it } from "vitest";
import { DEFAULT_STAGE_DAYS, estimateOffers, learnStageDays, offerWindow, timeToOfferDays, titleFamily, type TimingApp } from "../src/index.js";
import cases from "./fixtures/title_cases.json";

const app = (id: string, state: string, submittedAt: string, reached: TimingApp["reached"] = {}, tier: TimingApp["tier"] = null): TimingApp =>
  ({ id, companyId: id, company: id.toUpperCase(), tier, state, submittedAt, reached });

describe("title families (B5)", () => {
  it("match the shared fixture", () => {
    for (const [raw, expected] of cases as Array<[string, string]>) expect(titleFamily(raw), raw).toBe(expected);
  });
});

describe("timing (B5)", () => {
  it("learns stage durations from two or more of your own processes, per stage", () => {
    const l = learnStageDays([
      app("a", "offer", "2026-01-01", { screen: "2026-01-09", interview: "2026-01-20", offer: "2026-02-01" }),
      app("b", "rejected", "2026-01-05", { screen: "2026-01-11", interview: "2026-01-25" }),
      app("c", "rejected", "2026-01-10", { screen: "2026-01-20" }),
    ]);
    expect(l.days).toEqual({ toScreen: 8, screenToInterview: 13, interviewToOffer: DEFAULT_STAGE_DAYS.interviewToOffer });
    expect(l.basis).toEqual({ toScreen: "yours", screenToInterview: "yours", interviewToOffer: "default" });
  });

  it("ignores stages logged the same day, which are catch-up rather than real durations", () => {
    const l = learnStageDays([
      app("a", "interview", "2026-01-01T10:00:00Z", { screen: "2026-01-01T10:05:00Z", interview: "2026-01-01T10:06:00Z" }),
      app("b", "interview", "2026-01-02T10:00:00Z", { screen: "2026-01-02T10:05:00Z", interview: "2026-01-02T10:06:00Z" }),
    ]);
    expect(l.days).toEqual(DEFAULT_STAGE_DAYS);
    expect(l.samples).toEqual({ toScreen: 0, screenToInterview: 0, interviewToOffer: 0 });
  });

  it("estimates each live process from its latest stage and builds a window around it", () => {
    const learned = learnStageDays([]);
    expect(timeToOfferDays(learned.days)).toBe(36);
    const today = new Date("2026-11-23T00:00:00Z");
    const est = estimateOffers([
      app("x", "interview", "2026-10-01", { screen: "2026-10-15", interview: "2026-11-20" }),
      app("y", "submitted", "2026-11-20"),
      app("z", "rejected", "2026-10-01"),
    ], learned, today);
    expect(est.map((e) => [e.appId, e.expectedOffer])).toEqual([["x", "2026-12-04"], ["y", "2026-12-26"]]);
    expect(offerWindow(est, "2026-12-10")).toEqual({ start: "2026-11-30", end: "2026-12-20", inside: 1, source: "yours" });
    expect(offerWindow([], null).source).toBe("none");
  });
});
