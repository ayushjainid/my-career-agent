import { describe, expect, it } from "vitest";
import { buildDailyQueue, contactStrength, extractRequirements, type QueueInput, type QueueJob } from "../src/index.js";

const today = new Date("2026-11-22T06:05:00Z");
const desc = "Requirements\n- 5+ years of Python\n- SQL\n- AWS\nNice to have\n- Kubernetes";

const job = (id: string, companyId: string, over: Partial<QueueJob> = {}): QueueJob => ({
  jobId: id,
  companyId,
  title: "Senior Data Engineer",
  country: "US",
  descriptionText: desc,
  requirements: extractRequirements("Senior Data Engineer", desc),
  postedAt: "2026-11-20T00:00:00Z",
  status: "open",
  payMax: 200000,
  payCurrency: "USD",
  integrityLevel: "clean",
  sponsor: { filings: 40, permCertified: 12, permDenied: 0, lastFilingDate: "2026-09-30" },
  ...over,
});

const base = (jobs: QueueJob[], over: Partial<QueueInput> = {}): QueueInput => ({
  jobs,
  profile: {
    seniority: "senior",
    facts: [
      { id: "f1", kind: "role", text: "Data engineer at Acme", skills: ["python", "sql", "aws"], startDate: "2018-01-01", endDate: null, verified: true },
    ],
  },
  languages: [{ language: "English", level: "C2" }],
  workAuth: { US: { status: "needs_sponsorship", thresholds: { minFilings: 5, minPermCertified: 3 } } },
  prefs: new Map(),
  recentApplicationsByCompany: new Map(),
  alreadyApplied: new Set(),
  payFloor: null,
  contacts: [],
  today,
  dailyTarget: 10,
  activeProcesses: 0,
  maxActiveProcesses: 8,
  offerWindowStart: null,
  ...over,
});

describe("daily queue (P3)", () => {
  it("queues good jobs and gives a reason for every excluded one", () => {
    const r = buildDailyQueue(
      base([
        job("ok", "c1"),
        job("russian", "c2", { descriptionText: `${desc}\nFluent Russian required.` }),
        job("citizen", "c3", { descriptionText: `${desc}\nMust be a U.S. citizen.` }),
        job("nosponsor", "c4", { sponsor: null }),
        job("lowfit", "c5", { title: "Nurse", requirements: extractRequirements("Registered Nurse", "Requirements\n- Nursing licence\n- Patient care") }),
        job("blocked", "c6"),
      ], { prefs: new Map([["c6", { companyId: "c6", blockMode: "hard", blockReason: "Former employer" }]]) }),
    );
    expect(r.queue.map((q) => q.jobId)).toEqual(["ok"]);
    const reasons = Object.fromEntries(r.excluded.map((e) => [e.jobId, e.reason]));
    expect(Object.keys(reasons).sort()).toEqual(["blocked", "citizen", "lowfit", "nosponsor", "russian"]);
    expect(reasons.russian).toMatch(/russian/i);
    expect(reasons.citizen).toMatch(/Citizens only/);
    expect(reasons.nosponsor).toMatch(/sponsorship/);
    expect(reasons.blocked).toMatch(/Former employer/);
    expect(r.excluded.every((e) => e.reason.length > 0)).toBe(true);
  });

  it("ranks a job with a referral above an otherwise equal one", () => {
    const r = buildDailyQueue(
      base([job("a", "c1"), job("b", "c2")], {
        contacts: [{ companyId: "c2", messagesCount: 12, lastMessageAt: "2026-10-01", connectedOn: "2020-01-01", lastAskAt: null }],
      }),
    );
    expect(r.queue.map((q) => q.jobId)).toEqual(["b", "a"]);
    expect(r.queue[0]?.referralStrength).toBeGreaterThan(0.5);
  });

  it("holds dream companies back until the offer window, then releases them", () => {
    const prefs = new Map([["c2", { companyId: "c2", tier: "dream" as const }]]);
    const early = buildDailyQueue(base([job("a", "c1"), job("dream", "c2")], { prefs, offerWindowStart: new Date("2027-02-01") }));
    expect(early.queue.map((q) => q.jobId)).toEqual(["a"]);
    expect(early.heldBack[0]).toMatchObject({ jobId: "dream", releaseOn: "2026-12-28" });
    const later = buildDailyQueue(base([job("a", "c1"), job("dream", "c2")], { prefs, offerWindowStart: new Date("2026-12-01") }));
    expect(later.queue.map((q) => q.jobId).sort()).toEqual(["a", "dream"]);
  });

  it("flags but keeps jobs with a gate FLAG or an integrity alarm", () => {
    const r = buildDailyQueue(base([job("flag", "c1", { descriptionText: `${desc}\nActive TS/SCI clearance.`, integrityLevel: "alarm" })], {
      workAuth: { US: { status: "citizen", thresholds: { minFilings: 5, minPermCertified: 3 } } },
    }));
    expect(r.queue).toHaveLength(1);
    expect(r.queue[0]?.flags.join(" ")).toMatch(/clearance/i);
    expect(r.queue[0]?.flags.join(" ")).toMatch(/hidden or instruction-like/);
  });

  it("is deterministic and respects the daily target and one job per company", () => {
    const jobs = Array.from({ length: 30 }, (_, i) => job(`j${String(i).padStart(2, "0")}`, `c${i % 12}`));
    const a = buildDailyQueue(base(jobs, { dailyTarget: 5 }));
    const b = buildDailyQueue(base([...jobs].reverse(), { dailyTarget: 5 }));
    expect(a.queue.map((q) => q.jobId)).toEqual(b.queue.map((q) => q.jobId));
    expect(a.queue).toHaveLength(5);
    expect(new Set(a.queue.map((q) => q.companyId)).size).toBe(5);
  });

  it("scores contacts: conversation and recency count, a recent ask weakens", () => {
    const strong = contactStrength({ companyId: "x", messagesCount: 10, lastMessageAt: "2026-10-01", connectedOn: "2019-01-01", lastAskAt: null }, today);
    const asked = contactStrength({ companyId: "x", messagesCount: 10, lastMessageAt: "2026-10-01", connectedOn: "2019-01-01", lastAskAt: "2026-11-01" }, today);
    const cold = contactStrength({ companyId: "x", messagesCount: 0, lastMessageAt: null, connectedOn: "2026-06-01", lastAskAt: null }, today);
    expect(strong).toBeGreaterThan(asked);
    expect(asked).toBeGreaterThan(0);
    expect(cold).toBe(0.2);
  });
});
