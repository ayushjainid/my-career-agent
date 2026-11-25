// Pay-range parsing from posting text, for boards without structured compensation.
// Handles "$120,000 - $150,000", "$120k–$150k", "£45,000 to £55,000 per annum", "€60.000 - €75.000",
// "CA$90,000—110,000", "$45 - $60 per hour". Conservative: returns null when unsure.

import type { PayRange } from "./types.js";

const CURRENCY_TOKENS: Array<[RegExp, string]> = [
  [/^(?:CA\$|C\$|CAD)/i, "CAD"],
  [/^(?:A\$|AUD)/i, "AUD"],
  [/^(?:US\$|USD|\$)/i, "USD"],
  [/^(?:£|GBP)/i, "GBP"],
  [/^(?:€|EUR)/i, "EUR"],
];

const RANGE =
  /(CA\$|C\$|US\$|A\$|\$|£|€|USD|CAD|GBP|EUR|AUD)\s?(\d{1,3}(?:[,.\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|K)?\s*(?:-|–|—|to)\s*(?:CA\$|C\$|US\$|A\$|\$|£|€|USD|CAD|GBP|EUR|AUD)?\s?(\d{1,3}(?:[,.\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|K)?/;

function toNumber(raw: string, k: boolean): number {
  // Treat "60.000" (EU thousands) and "60,000" alike; keep real decimals like "45.50".
  let s = raw.replace(/\s/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return k ? n * 1000 : n;
}

// Italian postings: "RAL 45.000 - 55.000 €", "RAL: 40-50k", "Retribuzione annua lorda da 38.000 a 45.000 euro",
// and amounts with the euro sign after the number ("45.000€ - 55.000€"). RAL is always a gross annual figure.
const NUM = String.raw`(\d{1,3}(?:[.\s]\d{3})+|\d{2,6})`;
const RAL = new RegExp(String.raw`\b(?:RAL|retribuzione(?: annua)?(?: lorda)?|stipendio(?: annuo)?(?: lordo)?|compenso(?: annuo)?(?: lordo)?)\b[^\d€\n]{0,25}(?:€\s?)?` + NUM +
  String.raw`\s?(k)?\s*(?:€|euro|eur)?\s*(?:-|–|—|a|fino a|e)\s*(?:€\s?)?` + NUM + String.raw`\s?(k)?`, "i");
const EURO_AFTER = new RegExp(NUM + String.raw`\s?(k)?\s*(?:€|euro|EUR)?\s*(?:-|–|—)\s*` + NUM + String.raw`\s?(k)?\s*(?:€|euro\b|EUR\b)`, "i");

function parseItalian(text: string): PayRange | null {
  const ral = RAL.exec(text);
  const m = ral ?? EURO_AFTER.exec(text);
  if (!m) return null;
  const [, a, k1, b, k2] = m;
  const k = Boolean(k1 || k2);
  // After "RAL", small numbers are thousands: "RAL 40-50" means €40,000 to €50,000.
  const scale = (raw: string, hasK: boolean) => { const n = toNumber(raw, hasK); return ral && n < 1000 ? n * 1000 : n; };
  let min = scale(a!, Boolean(k1) || k), max = scale(b!, Boolean(k2) || k);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
  if (min > max) [min, max] = [max, min];
  if (max < 10_000 || max > 2_000_000) return null;
  return { min, max, currency: "EUR", period: "year", source: "text" };
}

export function parsePayFromText(text: string): PayRange | null {
  const m = RANGE.exec(text);
  if (!m) return parseItalian(text);
  const [, cur, a, k1, b, k2] = m;
  const currency = CURRENCY_TOKENS.find(([re]) => re.test(cur ?? ""))?.[1] ?? null;
  const bothK = Boolean(k1 || k2);
  let min = toNumber(a!, Boolean(k1) || (bothK && !k1 && Number(a) < 1000));
  let max = toNumber(b!, Boolean(k2) || (bothK && !k2 && Number(b) < 1000));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
  if (min > max) [min, max] = [max, min];

  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
  let period: PayRange["period"] = "unknown";
  if (/(per|an|\/)\s*(hour|hr)\b|hourly/.test(after)) period = "hour";
  else if (/(per|a|\/)\s*month|monthly/.test(after)) period = "month";
  else if (/(per|a|\/)\s*(year|yr|annum)|annual|annually|yearly/.test(after) || max >= 20000) period = "year";

  // Sanity bounds: reject things like "$5 - $10 million revenue".
  if (/^\s*(million|billion|mm|bn|m\b|b\b)/.test(after)) return null;
  if (period === "unknown" && max < 1_000) return null;
  if (period === "year" && (max < 10_000 || max > 2_000_000)) return null;
  if (period === "hour" && max > 1_000) return null;

  return { min, max, currency, period, source: "text" };
}
