import { describe, expect, it } from "vitest";
import nameCasesJson from "./fixtures/name_cases.json";

const nameCases = nameCasesJson as Array<[string, string]>;
import {
  blockStatus,
  canonicalizeSkill,
  extractRequirements,
  findSkills,
  gapSuggestions,
  normalizeCompanyName,
  parsePayFromText,
  planToday,
  rankCandidates,
  scoreResume,
  sponsorshipScore,
  sponsorshipSignal,
  yearsOfExperience,
  type Candidate,
  type CompanyPreference,
  type Fact,
} from "../src/index.js";

const JOB = `About the role
You will build data pipelines for our payments team.

Requirements
- 5+ years of experience with Python and SQL
- Experience with AWS and Airflow
- Strong communication skills

Nice to have
- Spark or Kubernetes
- Experience with Go

Benefits
- Great team that will react quickly to feedback`;

describe("skills and extraction", () => {
  it("matches tricky skill names on boundaries", () => {
    expect(findSkills("We use C++, C# and Node.js")).toEqual(expect.arrayContaining(["c++", "c#", "node.js"]));
    expect(findSkills("ability to go fast and excel at work, react to change")).toEqual([]);
    expect(findSkills("Go, Excel and React")).toEqual(expect.arrayContaining(["go", "excel", "react"]));
  });

  it("canonicalises aliases", () => {
    expect(canonicalizeSkill("golang")).toBe("go");
    expect(canonicalizeSkill("PostgreSQL")).toBe("sql");
    expect(canonicalizeSkill("Underwater Basket Weaving")).toBe("underwater basket weaving");
  });

  it("separates must-haves from nice-to-haves and reads years", () => {
    const req = extractRequirements("Senior Data Engineer", JOB);
    expect(req.mustHave).toEqual(["airflow", "aws", "communication", "python", "sql"]);
    expect(req.niceToHave).toEqual(["go", "kubernetes", "spark"]);
    expect(req.minYears).toBe(5);
    expect(req.seniority).toBe("senior");
  });

  it("treats every skill as must-have when there are no sections", () => {
    const req = extractRequirements("Nurse", "We need an RN with BLS and Epic experience.");
    expect(req.mustHave).toEqual(["bls certification", "electronic health records", "registered nurse"]);
  });

  it("detects sponsorship language, negative first", () => {
    expect(sponsorshipSignal("We are unable to sponsor visas for this role.")).toBe("negative");
    expect(sponsorshipSignal("Must be authorized to work without sponsorship.")).toBe("negative");
    expect(sponsorshipSignal("Visa sponsorship is available.")).toBe("positive");
    expect(sponsorshipSignal("Hybrid role in Austin.")).toBe("none");
  });
});

const facts: Fact[] = [
  { id: "r1", kind: "role", text: "Data Engineer at Acme", skills: ["python", "sql", "aws"], startDate: "2018-01-01", endDate: "2021-01-01", verified: true },
  { id: "r2", kind: "role", text: "Senior Data Engineer at Beta, ran Airflow pipelines", skills: ["python", "golang"], startDate: "2020-06-01", endDate: null, verified: true },
  { id: "s1", kind: "skill", text: "Kubernetes", skills: ["k8s"], verified: false },
];

describe("scoring (F2)", () => {
  const today = new Date("2026-11-22");

  it("merges overlapping roles when counting years", () => {
    expect(yearsOfExperience(facts, today)).toBeCloseTo(8.9, 1);
  });

  it("scores deterministically and ignores unverified facts", () => {
    const req = extractRequirements("Senior Data Engineer", JOB);
    const a = scoreResume(req, { facts, seniority: "senior" }, { today });
    const b = scoreResume(req, { facts, seniority: "senior" }, { today });
    expect(a).toEqual(b);
    expect(a.matched).toEqual(expect.arrayContaining(["python", "sql", "aws", "go"]));
    expect(a.gaps).toEqual(["airflow", "communication", "kubernetes", "spark"]);
    expect(a.total).toBeGreaterThan(60);
    expect(a.total).toBeLessThan(90);
    expect(a.scorerVersion).toBe("det-1");
  });

  it("flags seniority gaps", () => {
    const req = extractRequirements("Director of Engineering", JOB);
    const s = scoreResume(req, { facts, seniority: "mid" }, { today });
    expect(s.redFlags.some((f) => f.includes("Seniority"))).toBe(true);
  });

  it("only suggests gap fixes backed by a verified fact", () => {
    const tips = gapSuggestions(["airflow", "spark"], facts);
    expect(tips[0]).toMatchObject({ skill: "airflow", factId: "r2" });
    expect(tips[1]).toMatchObject({ skill: "spark", factId: null });
  });
});

describe("sponsorship", () => {
  const t = { minFilings: 5, minPermCertified: 3 };
  it("fails on negative posting text regardless of filings", () => {
    const s = sponsorshipScore({ filings: 100, permCertified: 50, permDenied: 0, lastFilingDate: "2026-09-01" }, t, "negative");
    expect(s.passes).toBe(false);
    expect(s.score).toBe(0);
  });
  it("passes strong sponsors and penalises stale ones", () => {
    const fresh = sponsorshipScore({ filings: 20, permCertified: 10, permDenied: 1, lastFilingDate: "2026-08-01" }, t, "none", new Date("2026-11-22"));
    const stale = sponsorshipScore({ filings: 20, permCertified: 10, permDenied: 1, lastFilingDate: "2024-01-01" }, t, "none", new Date("2026-11-22"));
    expect(fresh.passes).toBe(true);
    expect(stale.score).toBeLessThan(fresh.score);
  });
});

describe("blacklist and ranking", () => {
  const today = new Date("2026-11-22");
  const prefs = new Map<string, CompanyPreference>([
    ["blocked", { companyId: "blocked", blockMode: "hard", blockReason: "current employer" }],
    ["expired", { companyId: "expired", blockMode: "hard", blockExpiresAt: "2026-01-01" }],
    ["parent", { companyId: "parent", blockMode: "hard", includeSubsidiaries: true }],
    ["dreamco", { companyId: "dreamco", tier: "dream" }],
  ]);
  const parentOf = new Map([["child", "parent"]]);

  it("honours expiry and subsidiaries", () => {
    expect(blockStatus("blocked", prefs, parentOf, today).blocked).toBe(true);
    expect(blockStatus("expired", prefs, parentOf, today).blocked).toBe(false);
    expect(blockStatus("child", prefs, parentOf, today).blocked).toBe(true);
    expect(blockStatus("other", prefs, parentOf, today).blocked).toBe(false);
  });

  const base: Omit<Candidate, "jobId" | "companyId"> = {
    fitScore: 80, referralStrength: 0, postedAt: "2026-11-20", sponsorship: null, payMax: null, payCurrency: null, status: "open",
  };
  const cands: Candidate[] = [
    { ...base, jobId: "j-blocked", companyId: "blocked" },
    { ...base, jobId: "j-child", companyId: "child" },
    { ...base, jobId: "j-plain", companyId: "plainco" },
    { ...base, jobId: "j-ref", companyId: "refco", referralStrength: 0.8 },
    { ...base, jobId: "j-old", companyId: "oldco", postedAt: "2026-09-01" },
    { ...base, jobId: "j-nospons", companyId: "nsco", sponsorship: { score: 0.1, passes: false } },
    { ...base, jobId: "j-cheap", companyId: "cheapco", payMax: 80000, payCurrency: "USD" },
    { ...base, jobId: "j-capped", companyId: "capco" },
    { ...base, jobId: "j-dream", companyId: "dreamco" },
  ];

  it("applies hard filters before ranking and puts referrals on top", () => {
    const { ranked, excluded } = rankCandidates(cands, {
      prefs, parentOf, today,
      recentApplicationsByCompany: new Map([["capco", 2]]),
      alreadyApplied: new Set(),
      payFloor: { amount: 100000, currency: "USD" },
    });
    expect(excluded.map((e) => e.jobId).sort()).toEqual(["j-blocked", "j-capped", "j-cheap", "j-child", "j-nospons"]);
    expect(ranked[0]!.jobId).toBe("j-ref");
    expect(ranked.at(-1)!.jobId).toBe("j-old");
    expect(ranked.find((r) => r.jobId === "j-dream")!.tier).toBe("dream");
  });

  it("holds dream companies back until their release date", () => {
    const { ranked } = rankCandidates(cands, {
      prefs, parentOf, today, recentApplicationsByCompany: new Map(), alreadyApplied: new Set(), payFloor: null,
    });
    const plan = planToday({
      ranked, today, offerWindowStart: new Date("2027-02-01"), dailyTarget: 3,
      activeProcesses: 0, maxActiveProcesses: 8, timeToOfferDays: () => 49,
    });
    expect(plan.today).toHaveLength(3);
    expect(plan.today.some((c) => c.jobId === "j-dream")).toBe(false);
    expect(plan.heldBack).toEqual([{ jobId: "j-dream", companyId: "dreamco", releaseOn: "2026-12-14" }]);
  });

  it("stops new applications at the interview limit", () => {
    const plan = planToday({
      ranked: [], today, offerWindowStart: today, dailyTarget: 10, activeProcesses: 8, maxActiveProcesses: 8, timeToOfferDays: () => 30,
    });
    expect(plan.effectiveTarget).toBe(0);
    expect(plan.note).toMatch(/No new applications/);
  });
});

describe("names and pay", () => {
  it("normalises legal names (shared cases with the Python jobs)", () => {
    for (const [input, expected] of nameCases) expect(normalizeCompanyName(input), input).toBe(expected);
  });

  it("parses common pay formats", () => {
    expect(parsePayFromText("The base salary range is $120,000 - $150,000 per year.")).toMatchObject({ min: 120000, max: 150000, currency: "USD", period: "year" });
    expect(parsePayFromText("Pay: $120k–$150k")).toMatchObject({ min: 120000, max: 150000, period: "year" });
    expect(parsePayFromText("£45,000 to £55,000 per annum")).toMatchObject({ currency: "GBP", min: 45000, max: 55000 });
    expect(parsePayFromText("€60.000 - €75.000 brutto")).toMatchObject({ currency: "EUR", min: 60000, max: 75000 });
    expect(parsePayFromText("CA$90,000—110,000 annually")).toMatchObject({ currency: "CAD", min: 90000, max: 110000 });
    expect(parsePayFromText("$45 - $60 per hour")).toMatchObject({ period: "hour", min: 45, max: 60 });
    expect(parsePayFromText("We grew from $5 - $10 million in revenue")).toBeNull();
    expect(parsePayFromText("No numbers here")).toBeNull();
  });
});
