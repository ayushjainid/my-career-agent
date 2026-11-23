// POC loop P4: referrals from the user's own LinkedIn data export (Settings > Data privacy >
// Get a copy of your data). No scraping, no LinkedIn login: the user uploads two CSV files.

import { normalizeCompanyName } from "./names.js";

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** LinkedIn writes "05 Mar 2021" in Connections.csv; messages use "2024-03-05 14:02:11 UTC". */
export function parseLinkedInDate(s: string): string | null {
  const t = s.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(t);
  if (!m) return null;
  const month = MONTHS.indexOf((m[2] as string).toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${(m[1] as string).padStart(2, "0")}`;
}

export interface LinkedInConnection {
  /** Stable per person: the profile URL, or the name when LinkedIn left the URL out. */
  key: string;
  fullName: string;
  firstName: string;
  profileUrl: string | null;
  email: string | null;
  companyName: string | null;
  companyNorm: string | null;
  position: string | null;
  connectedOn: string | null;
  messagesCount: number;
  lastMessageAt: string | null;
}

const cleanUrl = (u: string | undefined): string | null => {
  const t = (u ?? "").trim();
  if (!/^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(t)) return null;
  return t.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
};

/** Find the header row by its column names: the export starts with a few "Notes" lines. */
function headerIndex(rows: string[][], must: string[]): number {
  return rows.findIndex((r) => {
    const names = r.map((c) => c.trim().toLowerCase());
    return must.every((m) => names.includes(m));
  });
}

export interface ImportResult {
  connections: LinkedInConnection[];
  skipped: number;
  messageFileUsed: boolean;
  warnings: string[];
}

/**
 * Parse Connections.csv (required) and messages.csv (optional, adds conversation counts).
 * Rows without a name are skipped; nothing is invented for missing columns.
 */
export function parseLinkedInExport(connectionsCsv: string, messagesCsv?: string | null): ImportResult {
  const warnings: string[] = [];
  const rows = parseCsv(connectionsCsv);
  const h = headerIndex(rows, ["first name", "last name"]);
  if (h < 0) throw new Error("This does not look like LinkedIn's Connections.csv (no First Name / Last Name header).");
  const header = (rows[h] as string[]).map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [cFirst, cLast, cUrl, cEmail, cCompany, cPosition, cConnected] = [
    col("first name"), col("last name"), col("url"), col("email address"), col("company"), col("position"), col("connected on"),
  ];
  if (cCompany < 0) warnings.push("No Company column: contacts cannot be matched to employers.");

  // Message counts per profile URL, from either side of each conversation.
  const counts = new Map<string, { n: number; last: string | null }>();
  let messageFileUsed = false;
  if (messagesCsv && messagesCsv.trim()) {
    const mrows = parseCsv(messagesCsv);
    const mh = headerIndex(mrows, ["from", "date"]);
    if (mh < 0) warnings.push("messages.csv was not recognised and was ignored.");
    else {
      messageFileUsed = true;
      const mhead = (mrows[mh] as string[]).map((c) => c.trim().toLowerCase());
      const [mSender, mRecipients, mDate] = [mhead.indexOf("sender profile url"), mhead.indexOf("recipient profile urls"), mhead.indexOf("date")];
      for (const r of mrows.slice(mh + 1)) {
        const date = parseLinkedInDate(r[mDate] ?? "");
        const people = [r[mSender], ...(r[mRecipients] ?? "").split(/[,;\s]+/)].map(cleanUrl).filter((u): u is string => !!u);
        for (const url of new Set(people)) {
          const cur = counts.get(url) ?? { n: 0, last: null };
          cur.n++;
          if (date && (!cur.last || date > cur.last)) cur.last = date;
          counts.set(url, cur);
        }
      }
    }
  }

  const seen = new Set<string>();
  const connections: LinkedInConnection[] = [];
  let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const first = (r[cFirst] ?? "").trim();
    const last = (r[cLast] ?? "").trim();
    const fullName = `${first} ${last}`.trim();
    if (!fullName) {
      skipped++;
      continue;
    }
    const profileUrl = cUrl >= 0 ? cleanUrl(r[cUrl]) : null;
    const key = profileUrl ?? `name:${fullName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const companyName = cCompany >= 0 ? (r[cCompany] ?? "").trim() || null : null;
    const m = profileUrl ? counts.get(profileUrl) : undefined;
    connections.push({
      key,
      fullName: fullName.slice(0, 200),
      firstName: (first || fullName).slice(0, 100),
      profileUrl,
      email: cEmail >= 0 ? (r[cEmail] ?? "").trim() || null : null,
      companyName,
      companyNorm: companyName ? normalizeCompanyName(companyName) || null : null,
      position: cPosition >= 0 ? (r[cPosition] ?? "").trim().slice(0, 200) || null : null,
      connectedOn: cConnected >= 0 ? parseLinkedInDate(r[cConnected] ?? "") : null,
      messagesCount: m?.n ?? 0,
      lastMessageAt: m?.last ?? null,
    });
  }
  return { connections, skipped, messageFileUsed, warnings };
}

export interface ReferralAskInput {
  contactFirstName: string;
  company: string;
  role: string;
  jobUrl: string | null;
  senderName: string;
  /** True when there is a real past conversation: the tone can be warmer. */
  warm: boolean;
}

/**
 * A short, specific ask the user edits and sends themselves on LinkedIn. It names the role and
 * link, makes saying no easy, and offers a resume so the contact does no work.
 */
export function draftReferralAsk(i: ReferralAskInput): string {
  const opener = i.warm ? `Hi ${i.contactFirstName}, hope you're doing well!` : `Hi ${i.contactFirstName}, hope all is well at ${i.company}.`;
  const link = i.jobUrl ? ` (${i.jobUrl})` : "";
  return [
    opener,
    `I'm applying for the ${i.role} role at ${i.company}${link} and I think my background fits it well.`,
    "Would you be comfortable referring me? I can send my resume and a two-line summary so it takes you a minute.",
    "Completely fine if not, and thanks either way!",
    i.senderName,
  ].join("\n");
}
