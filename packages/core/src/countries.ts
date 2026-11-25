// Beta loop B7: country packs. Each supported country says how a job's location maps to it, what
// public sponsor evidence exists, how that evidence is scored, and its default thresholds.
//   US: DOL H-1B LCA and PERM filings.   GB: Home Office register of licensed sponsors.
//   CA: ESDC positive LMIA employers.    IE: DETE employment permits issued to companies.
//   IT: no public employer register; the posting text decides, plus the EU Blue Card pay minimum.
//   Everything else: no evidence; the posting text decides.

import { sponsorshipScore, type SponsorEvidence, type SponsorScore, type SponsorThresholds } from "./sponsorship.js";

export type Country = "US" | "GB" | "CA" | "IE" | "IT";
export const SUPPORTED_COUNTRIES: Country[] = ["US", "GB", "CA", "IE", "IT"];

/** The pay a work permit needs. Checked against posted pay when the person needs sponsorship. */
export interface PermitMinimum {
  permit: string;
  annual: number;
  currency: string;
  /** When this figure took effect, and where it comes from: these change, so the app says so. */
  since: string;
  source: string;
  note?: string;
}

export const PERMIT_MINIMUMS: Partial<Record<Country, PermitMinimum[]>> = {
  IE: [
    { permit: "Critical Skills Employment Permit", annual: 40904, currency: "EUR", since: "2026-03-01", source: "Department of Enterprise, Tourism and Employment",
      note: "With a degree relevant to the role. Without one the minimum is €68,911." },
    { permit: "General Employment Permit", annual: 36605, currency: "EUR", since: "2026-03-01", source: "Department of Enterprise, Tourism and Employment" },
  ],
  IT: [
    { permit: "EU Blue Card (Carta Blu UE)", annual: 36300, currency: "EUR", since: "2026-10-13", source: "ISTAT average gross annual salary, as applied for Carta Blu",
      note: "Approximate: Italy ties it to the ISTAT average and the sector's collective agreement (CCNL). Check before you apply." },
  ],
};

export const COUNTRY_INFO: Record<Country, { name: string; currency: string; evidence: string; defaults: SponsorThresholds }> = {
  US: { name: "United States", currency: "USD", evidence: "H-1B LCA and PERM filings (Department of Labor)", defaults: { minFilings: 5, minPermCertified: 3 } },
  GB: { name: "United Kingdom", currency: "GBP", evidence: "Register of licensed sponsors: workers (Home Office)", defaults: { minFilings: 1, minPermCertified: 0 } },
  CA: { name: "Canada", currency: "CAD", evidence: "Positive LMIA employers list (ESDC)", defaults: { minFilings: 1, minPermCertified: 0 } },
  IE: { name: "Ireland", currency: "EUR", evidence: "Employment permits issued to companies (DETE)", defaults: { minFilings: 1, minPermCertified: 0 } },
  IT: { name: "Italy", currency: "EUR", evidence: "No public employer register; the posting's wording and the EU Blue Card pay minimum", defaults: { minFilings: 0, minPermCertified: 0 } },
};

/**
 * Whether posted pay can reach a permit's minimum. "below" when even the top of the range is under
 * the lowest permit minimum; "unknown" when pay isn't posted or is in another currency.
 */
export function permitPayCheck(country: string, pay: { max: number | null; min: number | null; currency: string | null; period?: string | null } | null):
  { status: "ok" | "below" | "unknown"; minimum: PermitMinimum | null } {
  const mins = PERMIT_MINIMUMS[country as Country];
  if (!mins?.length) return { status: "unknown", minimum: null };
  const lowest = [...mins].sort((a, b) => a.annual - b.annual)[0]!;
  const top = pay?.max ?? pay?.min ?? null;
  if (!pay || top === null || (pay.currency && pay.currency !== lowest.currency) || (pay.period && !["year", "unknown"].includes(pay.period))) return { status: "unknown", minimum: lowest };
  return { status: top < lowest.annual ? "below" : "ok", minimum: lowest };
}

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
  [/\b(ireland|[eé]ire|dublin|cork|galway|limerick|waterford|kilkenny|athlone|co\.\s*dublin)\b/i, "IE"],
  [/\b(italy|italia|milan|milano|rome|roma|turin|torino|bologna|florence|firenze|naples|napoli|genoa|genova|padua|padova|verona|bergamo|brescia|trieste|venice|venezia|pisa|bari|catania|palermo)\b/i, "IT"],
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
  if (country === "IE") {
    if (!e || e.filings < t.minFilings) return positive ? { score: 0.4, passes: true, reasons: ["No Irish employment permits on record; the posting mentions sponsorship."] } : { score: 0, passes: false, reasons: ["No Irish employment permits issued to this employer on record."] };
    return { score: Math.min(1, 0.45 + e.filings / 40), passes: true, reasons: [`${e.filings} Irish employment permits issued to this employer on record.`] };
  }
  if (country === "IT") {
    // Italy publishes no employer list. Large employers sponsor Blue Cards routinely; the posting decides.
    return positive ? { score: 0.6, passes: true, reasons: ["The posting mentions visa or Blue Card support."] } : { score: 0.25, passes: true, reasons: ["Italy publishes no sponsor list; check the posting and ask about the EU Blue Card."] };
  }
  if (country === "CA") {
    if (!e || e.filings < t.minFilings) return positive ? { score: 0.4, passes: true, reasons: ["No approved LMIAs on record; the posting mentions sponsorship."] } : { score: 0, passes: false, reasons: ["No approved LMIAs on record."] };
    return { score: Math.min(1, 0.4 + e.filings / 20), passes: true, reasons: [`${e.filings} approved LMIA positions on record.`] };
  }
  return positive ? { score: 0.4, passes: true, reasons: ["The posting mentions sponsorship."] } : { score: 0.2, passes: true, reasons: ["No public sponsor data for this country; check the posting."] };
}
