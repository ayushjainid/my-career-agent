// Sponsorship scoring from public filings (DOL LCA/PERM for the US; other packs plug in the same shape).

export interface SponsorEvidence {
  /** H-1B LCA filings (or the country's equivalent) for the user's occupation, last 24 months. */
  filings: number;
  /** Green-card (PERM) certifications, last 24-36 months. */
  permCertified: number;
  permDenied: number;
  /** Most recent filing date seen (ISO), for recency. */
  lastFilingDate: string | null;
}

export interface SponsorThresholds {
  minFilings: number;
  minPermCertified: number;
}

export interface SponsorScore {
  score: number; // 0-1
  passes: boolean;
  reasons: string[];
}

export function sponsorshipScore(
  e: SponsorEvidence,
  t: SponsorThresholds,
  textSignal: "positive" | "negative" | "none",
  today: Date = new Date(),
): SponsorScore {
  const reasons: string[] = [];
  if (textSignal === "negative") {
    return { score: 0, passes: false, reasons: ["The job posting says the employer will not sponsor."] };
  }

  const filingsPart = Math.min(1, e.filings / Math.max(1, 2 * t.minFilings));
  const decided = e.permCertified + e.permDenied;
  const denialRate = decided ? e.permDenied / decided : 0;
  const permPart = Math.min(1, e.permCertified / Math.max(1, 2 * t.minPermCertified)) * (1 - 0.5 * denialRate);
  let score = 0.4 * filingsPart + 0.6 * permPart;

  if (e.lastFilingDate) {
    const months = (today.getTime() - Date.parse(e.lastFilingDate)) / (30.44 * 24 * 3600 * 1000);
    if (months > 18) {
      score *= 0.7;
      reasons.push(`No filings in the last ${Math.floor(months)} months.`);
    }
  }
  if (textSignal === "positive") {
    score = Math.min(1, score + 0.15);
    reasons.push("The job posting mentions sponsorship.");
  }

  const passes = e.filings >= t.minFilings && e.permCertified >= t.minPermCertified;
  reasons.unshift(
    `${e.filings} H-1B filings and ${e.permCertified} certified PERM cases (${Math.round(denialRate * 100)}% denied).`,
  );
  if (!passes) reasons.push(`Below your thresholds (${t.minFilings} filings, ${t.minPermCertified} PERM).`);
  return { score: Math.round(score * 100) / 100, passes, reasons };
}
