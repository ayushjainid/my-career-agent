// Dates and date ranges as resumes write them.
import type { PartialDate } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  // German, French, Spanish, Dutch, Portuguese short forms that differ from English
  mär: 3, mrz: 3, mai: 5, okt: 10, dez: 12, janv: 1, févr: 2, fevr: 2, avr: 4, juil: 7, juin: 6, août: 8, aout: 8, déc: 12,
  ene: 1, abr: 4, ago: 8, dic: 12, mei: 5, maart: 3, fev: 2, set: 9, out: 10,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const PRESENT = "present|current|now|today|ongoing|till date|to date|heute|aujourd'hui|actuel|actualidad|presente|atual|nu";

/** One date: "Mar 2021", "March 2021", "03/2021", "2021-03", "2021", "Summer 2020". */
const ONE = `(?:(?:${MONTH_RE})\\.?,?\\s+'?\\d{2,4}|\\d{1,2}\\s*[/.]\\s*\\d{4}|\\d{4}\\s*[-/.]\\s*\\d{1,2}(?!\\d)|(?:spring|summer|fall|autumn|winter)\\s+\\d{4}|(?:19|20)\\d{2})`;
const SEP = `\\s*(?:-{1,3}|–|—|‒|―|~|to|until|bis|à|a|tot|till)\\s*`;
const RANGE_RE = new RegExp(`(${ONE})(?:${SEP}(${ONE}|${PRESENT}))?`, "i");
const RANGE_RE_G = new RegExp(RANGE_RE.source, "gi");

export function parseDate(s: string): PartialDate | null {
  const t = s.trim().toLowerCase().replace(/\.$/, "");
  let m = new RegExp(`^(${MONTH_RE})\\.?,?\\s+'?(\\d{2,4})$`, "i").exec(t);
  if (m) return ym(year(m[2]!), MONTHS[m[1]!.toLowerCase()]!);
  m = /^(\d{1,2})\s*[/.]\s*(\d{4})$/.exec(t);
  if (m) return ym(+m[2]!, +m[1]!);
  m = /^(\d{4})\s*[-/.]\s*(\d{1,2})$/.exec(t);
  if (m) return ym(+m[1]!, +m[2]!);
  m = /^(spring|summer|fall|autumn|winter)\s+(\d{4})$/.exec(t);
  if (m) return ym(+m[2]!, { spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12 }[m[1] as "spring"]);
  m = /^((?:19|20)\d{2})$/.exec(t);
  if (m) return m[1]!;
  return null;
}
function year(y: string): number {
  const n = +y;
  return y.length === 2 ? (n > 50 ? 1900 + n : 2000 + n) : n;
}
function ym(y: number, m: number): PartialDate | null {
  if (y < 1950 || y > 2100 || m < 1 || m > 12) return null;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export interface DateRange {
  start: PartialDate | null;
  end: PartialDate | null;
  current: boolean;
  /** The exact text matched, so callers can remove it from the line. */
  matched: string;
}

/** The first date or date range in the text, or null. A lone date is treated as the end. */
export function findDateRange(text: string): DateRange | null {
  const m = RANGE_RE.exec(text);
  if (!m) return null;
  // Reject a bare number that is really a figure ("handling 2019 events" is rare; "300 analysts" isn't a year).
  const first = parseDate(m[1]!);
  if (!first) return null;
  if (m[2] === undefined) {
    // A year alone inside a long sentence is probably not a date line.
    if (/^(?:19|20)\d{2}$/.test(m[1]!.trim()) && text.replace(m[0], "").trim().split(/\s+/).length > 8) return null;
    return { start: null, end: first, current: false, matched: m[0] };
  }
  const second = m[2].trim().toLowerCase();
  if (new RegExp(`^(?:${PRESENT})$`, "i").test(second)) return { start: first, end: null, current: true, matched: m[0] };
  const end = parseDate(m[2]);
  return { start: first, end, current: false, matched: m[0] };
}

/** Every date-looking span in a text (for stripping dates out of a header line). */
export function allDateSpans(text: string): string[] {
  return [...text.matchAll(RANGE_RE_G)].filter((m) => parseDate(m[1]!)).map((m) => m[0]);
}

/** Turns a partial date into the first day it covers, for storage: "2021-03" → "2021-03-01". */
export function toIsoStart(d: PartialDate | null): string | null {
  if (!d) return null;
  return d.length === 4 ? `${d}-01-01` : `${d}-01`;
}
/** Turns a partial date into the last day it covers: "2021-02" → "2021-02-28". */
export function toIsoEnd(d: PartialDate | null): string | null {
  if (!d) return null;
  if (d.length === 4) return `${d}-12-31`;
  const [y, m] = d.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${d}-${String(last).padStart(2, "0")}`;
}
