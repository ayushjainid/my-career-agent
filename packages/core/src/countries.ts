// Beta loop B7: country packs. Each supported country says how a job's location maps to it, what
// public sponsor evidence exists, how that evidence is scored, and its default thresholds.
//   US: DOL H-1B LCA and PERM filings.   GB: Home Office register of licensed sponsors.
//   CA: ESDC positive LMIA employers.    Everything else: no evidence; the posting text decides.

import { sponsorshipScore, type SponsorEvidence, type SponsorScore, type SponsorThresholds } from "./sponsorship.js";

export type Country = "US" | "GB" | "CA";
export const SUPPORTED_COUNTRIES: Country[] = ["US", "GB", "CA"];

export const COUNTRY_INFO: Record<Country, { name: string; currency: string; evidence: string; defaults: SponsorThresholds }> = {
  US: { name: "United States", currency: "USD", evidence: "H-1B LCA and PERM filings (Department of Labor)", defaults: { minFilings: 5, minPermCertified: 3 } },
  GB: { name: "United Kingdom", currency: "GBP", evidence: "Register of licensed sponsors: workers (Home Office)", defaults: { minFilings: 1, minPermCertified: 0 } },
  CA: { name: "Canada", currency: "CAD", evidence: "Positive LMIA employers list (ESDC)", defaults: { minFilings: 1, minPermCertified: 0 } },
};

/** "UK" is what people type; GB is the ISO code every table uses. */
export function normalizeCountry(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) return null;
  return c === "UK" ? "GB" : c;
}

const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const CA_PROVINCES = "ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU";
const RULES: Array<[RegExp, string]> = [
  [/\b(united kingdom|england|scotland|wales|northern ireland|london|manchester|edinburgh|glasgow|bristol|cambridge, uk|oxford, uk|birmingham, uk|leeds|belfast)\b|,\s*uk\b|\buk\b(?! remote)/i, "GB"],
  [/\b(canada|toronto|vancouver|montr[eé]al|ottawa|calgary|waterloo|edmonton|qu[eé]bec)\b/i, "CA"],
  [new RegExp(`,\\s*(${CA_PROVINCES})\\b(?!.*\\b(usa|united states)\\b)`), "CA"],
  [/\b(united states|usa|u\.s\.a?\.?|new york|san francisco|seattle|austin|boston|chicago|los angeles|remote[ -]+us)\b/i, "US"],
  [new RegExp(`,\\s*(${US_STATES})\\b`), "US"],
  [/\b(US|USA)\b/, "US"],
  [/\b(germany|berlin|munich|hamburg)\b/i, "DE"],
  [/\b(netherlands|amsterdam|rotterdam|eindhoven)\b/i, "NL"],
  [/\b(ireland|dublin)\b/i, "IE"],
  [/\b(france|paris)\b/i, "FR"],
  [/\b(spain|madrid|barcelona)\b/i, "ES"],
  [/\b(india|bangalore|bengaluru|hyderabad|pune)\b/i, "IN"],
  [/\b(singapore)\b/i, "SG"],
  [/\b(australia|sydney|melbourne)\b/i, "AU"],
];

/**
 * The country of a job from its free-text location. Returns null when unclear; callers keep
 * their previous default. "Remote" alone says nothing. Multi-location postings take the first hit.
 */
export function inferCountry(location: string | null | undefined): string | null {
  const t = (location ?? "").trim();
  if (!t) return null;
  for (const [re, code] of RULES) if (re.test(t)) return code;
  return null;
}

export interface CountryEvidence extends SponsorEvidence {
  /** GB: best licence rating seen ("A" or "B"). */
  rating?: string | null;
}

/** Sponsorship score by country. Unknown countries have no evidence: only the posting text counts. */
export function sponsorshipFor(country: string, e: CountryEvidence | null, t: SponsorThresholds, textSignal: "positive" | "negative" | "none", today = new Date()): SponsorScore {
  if (textSignal === "negative") return { score: 0, passes: false, reasons: ["The job posting says the employer will not sponsor."] };
  const positive = textSignal === "positive";
  if (country === "US") {
    if (!e) return positive ? { score: 0.5, passes: true, reasons: ["No filings on record; the posting mentions sponsorship."] } : { score: 0, passes: false, reasons: ["No H-1B or PERM filings on record."] };
    return sponsorshipScore(e, t, textSignal, today);
  }
  if (country === "GB") {
    if (!e || e.filings < 1) return positive ? { score: 0.4, passes: true, reasons: ["Not on the sponsor register; the posting mentions sponsorship."] } : { score: 0, passes: false, reasons: ["Not on the register of licensed sponsors for skilled workers."] };
    const a = (e.rating ?? "").toUpperCase().startsWith("A");
    return { score: a ? 0.85 : 0.4, passes: true, reasons: [`Licensed Skilled Worker sponsor${e.rating ? ` (${e.rating} rating)` : ""}.`, ...(a ? [] : ["A B rating means the licence is under an action plan."])] };
  }
  if (country === "CA") {
    if (!e || e.filings < t.minFilings) return positive ? { score: 0.4, passes: true, reasons: ["No approved LMIAs on record; the posting mentions sponsorship."] } : { score: 0, passes: false, reasons: ["No approved LMIAs on record."] };
    return { score: Math.min(1, 0.4 + e.filings / 20), passes: true, reasons: [`${e.filings} approved LMIA positions on record.`] };
  }
  return positive ? { score: 0.4, passes: true, reasons: ["The posting mentions sponsorship."] } : { score: 0.2, passes: true, reasons: ["No public sponsor data for this country; check the posting."] };
}
