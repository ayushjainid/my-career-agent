// Beta loop B2: a resume built only from verified facts, ordered for one role or job.
// The model is plain data; the API renders it to DOCX and PDF, and the same lines feed the ATS
// text check, so what the check reads is exactly what the file says.

import { checkTextLayer, type TextLayerReport } from "./atsText.js";
import { canonicalizeSkill, findSkills } from "./skills.js";
import type { Fact } from "./types.js";

export interface ResumeContact {
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  links: string[];
}

export interface ResumeTarget {
  title: string | null;
  /** Skills the role asks for, most important first (must-haves before nice-to-haves). */
  keywords: string[];
}

export interface ResumeRole {
  heading: string;
  org: string | null;
  dates: string | null;
  bullets: string[];
}

export interface ResumeDoc {
  contact: ResumeContact;
  headline: string | null;
  experience: ResumeRole[];
  projects: ResumeRole[];
  education: ResumeRole[];
  certifications: string[];
  skills: string[];
  languages: string[];
  /** Facts used, so the packet can show exactly what the resume claims. */
  factIds: string[];
  /** Verified achievements left out because their role or space did not fit. */
  omitted: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (iso: string | null | undefined) => {
  if (!iso) return null;
  const [y, m] = iso.split("-");
  const mi = Number(m) - 1;
  return y ? (mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${y}` : y) : null;
};
/** ASCII hyphen on purpose: some ATS parsers drop date ranges joined by an en or em dash. */
export function dateRange(start?: string | null, end?: string | null): string | null {
  const s = month(start);
  if (!s) return null;
  return `${s} - ${end ? month(end) : "Present"}`;
}

const overlaps = (a: Fact, b: Fact) => {
  const as = a.startDate ?? "0000", ae = a.endDate ?? "9999", bs = b.startDate ?? "0000", be = b.endDate ?? "9999";
  return as <= be && bs <= ae;
};
const sameOrg = (a: Fact, b: Fact) => !!a.org && !!b.org && a.org.trim().toLowerCase() === b.org.trim().toLowerCase();
const byRecency = (a: Fact, b: Fact) => (b.endDate ?? "9999").localeCompare(a.endDate ?? "9999") || (b.startDate ?? "").localeCompare(a.startDate ?? "");

/** How well one fact serves the target: must-haves weigh more, earlier keywords more than later. */
function relevance(f: Fact, keywords: string[]): number {
  const have = new Set([...f.skills.map((s) => canonicalizeSkill(s)), ...findSkills(f.text)]);
  return keywords.reduce((sum, k, i) => sum + (have.has(k) ? 1 + 1 / (i + 1) : 0), 0);
}

export interface BuildResumeOptions {
  maxBulletsPerRole?: number; // default 5
  maxSkills?: number; // default 24
}

export function buildResume(contact: ResumeContact, facts: Fact[], target: ResumeTarget, opts: BuildResumeOptions = {}): ResumeDoc {
  const maxBullets = opts.maxBulletsPerRole ?? 5;
  const keywords = target.keywords.map((k) => canonicalizeSkill(k));
  const verified = facts.filter((f) => f.verified);
  const used = new Set<string>();
  const of = (k: Fact["kind"]) => verified.filter((f) => f.kind === k).sort(byRecency);

  const roles = of("role");
  const achievements = of("achievement");
  // Attach each achievement to one role: same employer first, else the role whose dates contain it.
  const owner = new Map<string, string>();
  for (const a of achievements) {
    // Two roles at one employer (a promotion): the one whose dates contain the achievement.
    const role = roles.find((r) => sameOrg(r, a) && overlaps(r, a)) ?? roles.find((r) => sameOrg(r, a)) ?? roles.find((r) => a.startDate && overlaps(r, a));
    if (role) owner.set(a.id, role.id);
  }
  let omitted = 0;
  const experience: ResumeRole[] = roles.map((r) => {
    used.add(r.id);
    const mine = achievements
      .filter((a) => owner.get(a.id) === r.id)
      .map((a) => ({ a, score: relevance(a, keywords) }))
      .sort((x, y) => y.score - x.score || byRecency(x.a, y.a));
    const kept = mine.slice(0, maxBullets);
    omitted += mine.length - kept.length;
    for (const { a } of kept) used.add(a.id);
    return { heading: r.text, org: r.org ?? null, dates: dateRange(r.startDate, r.endDate), bullets: kept.map(({ a }) => a.text) };
  });
  omitted += achievements.filter((a) => !owner.has(a.id)).length;

  const simple = (k: Fact["kind"]): ResumeRole[] =>
    of(k).map((f) => {
      used.add(f.id);
      return { heading: f.text, org: f.org ?? null, dates: dateRange(f.startDate, f.endDate), bullets: [] };
    });
  const projects = of("project")
    .map((f) => ({ f, score: relevance(f, keywords) }))
    .sort((x, y) => y.score - x.score || byRecency(x.f, y.f))
    .slice(0, 4)
    .map(({ f }) => {
      used.add(f.id);
      return { heading: f.text, org: f.org ?? null, dates: dateRange(f.startDate, f.endDate), bullets: [] };
    });

  // Skills: the target's keywords the person verifiably has, first, then the rest by frequency.
  const freq = new Map<string, number>();
  for (const f of verified) for (const s of new Set([...f.skills.map((x) => canonicalizeSkill(x)), ...(f.kind === "skill" ? findSkills(f.text) : [])])) freq.set(s, (freq.get(s) ?? 0) + 1);
  for (const f of of("skill")) used.add(f.id);
  const skills = [...freq.keys()]
    .sort((a, b) => {
      const ia = keywords.indexOf(a), ib = keywords.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
      return (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b);
    })
    .slice(0, opts.maxSkills ?? 24);

  const certifications = of("certification").map((f) => {
    used.add(f.id);
    return [f.text, f.org, month(f.startDate)].filter(Boolean).join(", ");
  });
  const languages = of("language").map((f) => {
    used.add(f.id);
    return f.text;
  });

  return {
    contact,
    headline: target.title,
    experience,
    projects,
    education: simple("education"),
    certifications,
    skills,
    languages,
    factIds: [...used],
    omitted,
  };
}

/** The resume as the lines a reader (or an ATS) sees, in order. */
export function resumeLines(doc: ResumeDoc): string[] {
  const c = doc.contact;
  const lines = [c.name, [c.email, c.phone, c.location, ...c.links].filter(Boolean).join(" | ")];
  if (doc.headline) lines.push(doc.headline);
  const section = (title: string, rows: ResumeRole[]) => {
    if (!rows.length) return;
    lines.push("", title.toUpperCase());
    for (const r of rows) {
      lines.push([r.heading, r.org && !r.heading.toLowerCase().includes(r.org.toLowerCase()) ? r.org : null].filter(Boolean).join(", ") + (r.dates ? `  ${r.dates}` : ""));
      for (const b of r.bullets) lines.push(`- ${b}`);
    }
  };
  section("Experience", doc.experience);
  section("Projects", doc.projects);
  section("Education", doc.education);
  if (doc.certifications.length) lines.push("", "CERTIFICATIONS", ...doc.certifications);
  if (doc.skills.length) lines.push("", "SKILLS", doc.skills.join(", "));
  if (doc.languages.length) lines.push("", "LANGUAGES", doc.languages.join(", "));
  return lines;
}

/** The ATS text check, run on exactly what the resume says. */
export function checkResume(doc: ResumeDoc, lines: string[], pages: number | null, keywords: string[]): TextLayerReport {
  return checkTextLayer({
    text: lines.join("\n"),
    pages,
    expectedPages: { min: 1, max: 2 },
    minChars: 300,
    required: [doc.contact.name, ...[...doc.experience, ...doc.education].map((r) => r.org).filter((o): o is string => !!o)],
    keywords,
  });
}
