// Shared domain types. Kept free of runtime dependencies so they work in Workers, Node and the browser.

export type Seniority = "entry" | "mid" | "senior" | "lead" | "executive";
export type RemoteType = "remote" | "hybrid" | "onsite" | "unknown";
export type Tier = "warmup" | "mid" | "dream";
export type AtsVendor = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable";

/** A job as produced by any ATS adapter, before it is stored. */
export interface NormalizedJob {
  atsVendor: AtsVendor;
  atsJobId: string;
  title: string;
  locationText: string | null;
  remoteType: RemoteType;
  pay: PayRange | null;
  postedAt: string | null; // ISO 8601
  applyUrl: string | null;
  descriptionText: string;
  /** Posting integrity check of the raw description (postingGuard). Absent only in old fixtures. */
  integrity?: import("./postingGuard.js").IntegrityReport;
}

export interface PayRange {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "year" | "month" | "hour" | "unknown";
  source: "structured" | "text";
}

/** Requirements extracted from a job description (deterministic by default, AI optional). */
export interface JobRequirements {
  mustHave: string[];
  niceToHave: string[];
  minYears: number | null;
  seniority: Seniority | null;
  sponsorshipSignal: "positive" | "negative" | "none";
}

/** A verified entry from the user's fact bank. */
export interface Fact {
  id: string;
  kind: "role" | "achievement" | "skill" | "education" | "certification" | "project" | "language";
  text: string;
  skills: string[];
  startDate?: string | null; // ISO date
  endDate?: string | null; // ISO date; null = current
  verified: boolean;
}

export interface Profile {
  facts: Fact[];
  seniority: Seniority;
}

export interface ScoreBreakdown {
  total: number; // 0-100
  mustHaveCoverage: number; // 0-1
  niceToHaveCoverage: number; // 0-1
  seniorityFit: number; // 0-1
  yearsFit: number; // 0-1
  matched: string[];
  gaps: string[]; // missing must-haves first, then nice-to-haves
  redFlags: string[];
  scorerVersion: string;
}
