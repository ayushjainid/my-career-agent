// Deterministic requirement extraction. No AI: a skills dictionary plus section heuristics.
// The starter dictionary below is deliberately small and cross-occupation; production loads
// the ESCO skills taxonomy (https://esco.ec.europa.eu) into the same shape.

import type { JobRequirements, Seniority } from "./types.js";
import { detectLanguage } from "./postingLanguage.js";

export interface SkillEntry {
  canonical: string;
  /** Case-insensitive alternatives. */
  aliases?: string[];
  /** Case-sensitive forms, for skills that are also common words ("Go", "Excel", "React"). */
  exact?: string[];
  /** Set false when the canonical name alone is too ambiguous to match case-insensitively. */
  matchCanonical?: boolean;
}

export const STARTER_SKILLS: SkillEntry[] = [
  // Software and data
  { canonical: "python" },
  { canonical: "java" },
  { canonical: "javascript", aliases: ["ecmascript"] },
  { canonical: "typescript" },
  { canonical: "go", aliases: ["golang"], exact: ["Go"], matchCanonical: false },
  { canonical: "rust" },
  { canonical: "c++", aliases: ["cpp"] },
  { canonical: "c#", aliases: ["csharp", ".net", "dotnet"] },
  { canonical: "sql", aliases: ["postgres", "postgresql", "mysql"] },
  { canonical: "react", aliases: ["react.js", "reactjs"], exact: ["React"], matchCanonical: false },
  { canonical: "node.js", aliases: ["nodejs"] },
  { canonical: "kubernetes", aliases: ["k8s"] },
  { canonical: "docker" },
  { canonical: "aws", aliases: ["amazon web services"] },
  { canonical: "gcp", aliases: ["google cloud"] },
  { canonical: "azure" },
  { canonical: "terraform" },
  { canonical: "machine learning", aliases: ["ml", "apprendimento automatico"] },
  { canonical: "deep learning" },
  { canonical: "pytorch" },
  { canonical: "tensorflow" },
  { canonical: "spark", aliases: ["apache spark", "pyspark"], exact: ["Spark"], matchCanonical: false },
  { canonical: "airflow", aliases: ["apache airflow"] },
  { canonical: "data modeling", aliases: ["data modelling"] },
  { canonical: "statistics" },
  { canonical: "a/b testing", aliases: ["ab testing", "experimentation"] },
  { canonical: "distributed systems" },
  { canonical: "system design" },
  { canonical: "ci/cd" },
  { canonical: "kotlin" },
  { canonical: "scala" },
  { canonical: "swift", exact: ["Swift"], matchCanonical: false },
  { canonical: "php" },
  { canonical: "ruby", aliases: ["ruby on rails", "rails"] },
  { canonical: "kafka", aliases: ["apache kafka"] },
  { canonical: "graphql" },
  { canonical: "grpc" },
  { canonical: "spring", aliases: ["spring boot"], exact: ["Spring"], matchCanonical: false },
  { canonical: "django" },
  { canonical: "redis" },
  { canonical: "mongodb", aliases: ["mongo"] },
  { canonical: "elasticsearch", aliases: ["opensearch"] },
  { canonical: "snowflake", exact: ["Snowflake"], matchCanonical: false },
  { canonical: "dbt", exact: ["dbt", "DBT"], matchCanonical: false },
  { canonical: "microservices", aliases: ["microservizi", "micro-services"] },
  // Product, design, marketing, sales
  { canonical: "product management", aliases: ["product manager"] },
  { canonical: "roadmapping", aliases: ["roadmap", "roadmaps"] },
  { canonical: "user research" },
  { canonical: "figma" },
  { canonical: "ux design", aliases: ["user experience design"] },
  { canonical: "seo", aliases: ["search engine optimization", "search engine optimisation"] },
  { canonical: "content marketing" },
  { canonical: "salesforce" },
  { canonical: "account management" },
  { canonical: "negotiation" },
  // Finance and operations
  { canonical: "financial modeling", aliases: ["financial modelling"] },
  { canonical: "excel", aliases: ["microsoft excel", "ms excel"], exact: ["Excel"], matchCanonical: false },
  { canonical: "accounting" },
  { canonical: "gaap", aliases: ["us gaap"] },
  { canonical: "ifrs" },
  { canonical: "project management" },
  { canonical: "agile", aliases: ["scrum", "kanban"] },
  { canonical: "stakeholder management" },
  // Healthcare and regulated professions
  { canonical: "registered nurse", exact: ["RN"] },
  { canonical: "patient care" },
  { canonical: "bls certification", aliases: ["basic life support"], exact: ["BLS"] },
  { canonical: "acls", aliases: ["advanced cardiovascular life support"] },
  { canonical: "electronic health records", aliases: ["ehr", "emr"], exact: ["Epic"] },
  // Languages and general
  { canonical: "english" },
  { canonical: "german" },
  { canonical: "french" },
  { canonical: "dutch" },
  { canonical: "spanish" },
  { canonical: "communication", aliases: ["communication skills"] },
  { canonical: "leadership", aliases: ["people management", "team leadership"] },
];

export interface CompiledSkill {
  canonical: string;
  patterns: RegExp[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function boundary(terms: string[], flags: string): RegExp {
  const body = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9+#])`, flags);
}

/** Builds boundary-aware matchers. Works for "C++", "C#", ".NET", "Node.js". */
export function compileSkills(entries: SkillEntry[] = STARTER_SKILLS): CompiledSkill[] {
  return entries.map((e) => {
    const insensitive = [...(e.matchCanonical === false ? [] : [e.canonical]), ...(e.aliases ?? [])];
    const patterns: RegExp[] = [];
    if (insensitive.length) patterns.push(boundary(insensitive, "i"));
    if (e.exact?.length) patterns.push(boundary(e.exact, ""));
    return { canonical: e.canonical, patterns };
  });
}

const DEFAULT_COMPILED = compileSkills();

/** Maps any alias to its canonical skill name; unknown skills are lower-cased and trimmed. */
export function canonicalizeSkill(raw: string, compiled: CompiledSkill[] = DEFAULT_COMPILED): string {
  const value = raw.trim();
  const lower = value.toLowerCase();
  for (const s of compiled) {
    if (s.canonical === lower) return s.canonical;
    for (const p of s.patterns) {
      const m = p.exec(value);
      if (m && m[0].length === value.length) return s.canonical;
    }
  }
  return lower;
}

export function findSkills(text: string, compiled: CompiledSkill[] = DEFAULT_COMPILED): string[] {
  const found = new Set<string>();
  for (const s of compiled) if (s.patterns.some((p) => p.test(text))) found.add(s.canonical);
  return [...found];
}

// Headings end at punctuation, a space or the line's end: \b doesn't work after accented letters.
const END = String.raw`(?=[\s:.,!?()–—-]|$)`;
const MUST_HEADING = new RegExp(
  String.raw`^(?:#+\s*)?(requirements|qualifications|minimum qualifications|basic qualifications|what you(?:'|’)ll need|what we(?:'|’)re looking for|you have|must[- ]haves?|required skills|about you` +
    // Italian
    String.raw`|requisiti(?: richiesti| minimi| essenziali| tecnici)?|competenze(?: richieste| tecniche| e requisiti)?|conoscenze(?: richieste| tecniche)?|cosa cerchiamo|chi cerchiamo|il candidato ideale|la persona ideale|profilo ricercato|il tuo profilo|cosa ti serve|cosa porti)` + END,
  "i",
);
const NICE_HEADING = new RegExp(
  String.raw`^(?:#+\s*)?(nice[- ]to[- ]haves?|preferred(?: qualifications)?|bonus(?: points)?|pluses|desired(?: skills)?|it(?:'|’)s a plus` +
    String.raw`|gradit[oaie](?: anche)?|requisiti preferenziali|titoli preferenziali|costituisc(?:e|ono) titolo preferenziale|(?:sar[aà]|saranno) considerat[oaie] (?:un )?plus|plus|punti bonus)` + END,
  "i",
);
const OTHER_HEADING = new RegExp(
  String.raw`^(?:#+\s*)?(responsibilities|what you(?:'|’)ll do|about (?:the )?(?:role|team|us|company)|benefits|perks|compensation|our values|why join` +
    String.raw`|responsabilit[aà]|mansioni|attivit[aà]|principali attivit[aà]|cosa farai|di cosa ti occuperai|il ruolo|chi siamo|l'azienda|la nostra azienda|offriamo|cosa offriamo|perch[eé] unirti|benefit)` + END,
  "i",
);

type Section = "must" | "nice" | "other" | "none";

function sectionise(text: string): Array<{ section: Section; line: string }> {
  let current: Section = "none";
  const out: Array<{ section: Section; line: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const short = line.length <= 60;
    if (short && MUST_HEADING.test(line)) current = "must";
    else if (short && NICE_HEADING.test(line)) current = "nice";
    else if (short && OTHER_HEADING.test(line)) current = "other";
    out.push({ section: current, line });
  }
  return out;
}

const YEARS = /(\d{1,2})\s*\+?\s*(?:(?:-|–|to|a)\s*\d{1,2}\s*)?(?:\+\s*)?(?:years?|anni|anno)\b/i;

export function inferSeniorityFromTitle(title: string): Seniority {
  const t = title.toLowerCase();
  if (/\b(chief|vp|vice president|director|head of|direttore|direttrice)\b/.test(t)) return "executive";
  if (/\b(staff|principal|lead|manager|responsabile|team leader)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|esperto|esperta)\b/.test(t)) return "senior";
  if (/\b(intern|internship|graduate|new grad|junior|jr\.?|entry|associate|apprentice|stage|stagista|tirocinio|tirocinante|neolaureat[oa])\b/.test(t))
    return "entry";
  return "mid";
}

const NEGATIVE_SPONSORSHIP = [
  /\b(?:unable|not able|cannot|can(?:'|’)t|won(?:'|’)t|will not|do not|does not|don(?:'|’)t|are not able to|is not able to)\s+(?:to\s+)?(?:provide|offer|support)?\s*(?:visa\s+|immigration\s+|work\s+)?sponsor(?:ship)?/i,
  /\bwithout (?:the need for |requiring )?(?:current or future )?(?:visa |employer |immigration )?sponsorship\b/i,
  /\bno (?:visa |immigration )?sponsorship\b/i,
  /\bsponsorship (?:is )?not (?:available|offered|provided)\b/i,
  // Europe: the right to work is required up front.
  /\bmust (?:already )?(?:have|hold) (?:the |a )?(?:full |valid )?(?:right to work|work(?:ing)? permit|stamp 4)(?: in| for)? (?:ireland|italy|the eu|the eea|europe|the uk)\b/i,
  /\b(?:eu|eea) (?:citizenship|work permit|right to work) (?:is )?(?:required|mandatory)\b/i,
  /\bnon (?:offriamo|forniamo|prevediamo|è prevista|e prevista) (?:la )?(?:sponsorizzazione|sponsorship|supporto per il visto)\b/i,
  /(?:^|[\s(])(?:è|e) richiest[oa] (?:il |un |la )?(?:regolare )?(?:permesso di (?:lavoro|soggiorno)|cittadinanza (?:italiana|europea|ue))\b/i,
];
const POSITIVE_SPONSORSHIP = [
  /\bvisa sponsorship (?:is )?(?:available|offered|provided)\b/i,
  /\bwe (?:will|can|do) sponsor\b/i,
  /\bsponsorship (?:is )?(?:available|offered|provided)\b/i,
  /\bopen to sponsoring\b/i,
  /\b(?:critical skills|general) employment permit\b/i,
  /\b(?:we|can) (?:support|sponsor) (?:an? )?(?:employment|work) permits?\b/i,
  /\b(?:eu )?blue card (?:support|sponsorship)\b/i,
  /\b(?:sponsorizzazione|supporto) (?:per il |del )?visto\b/i,
  /\bcarta blu\b/i,
];

export function sponsorshipSignal(text: string): JobRequirements["sponsorshipSignal"] {
  if (NEGATIVE_SPONSORSHIP.some((r) => r.test(text))) return "negative";
  if (POSITIVE_SPONSORSHIP.some((r) => r.test(text))) return "positive";
  return "none";
}

/** Extracts requirements from a plain-text job description. Deterministic and repeatable. */
export function extractRequirements(
  title: string,
  description: string,
  compiled: CompiledSkill[] = DEFAULT_COMPILED,
): JobRequirements {
  const lines = sectionise(description);
  const hasSections = lines.some((l) => l.section === "must" || l.section === "nice");
  const must = new Set<string>();
  const nice = new Set<string>();
  let minYears: number | null = null;

  for (const { section, line } of lines) {
    const skills = findSkills(line, compiled);
    if (!hasSections || section === "must") skills.forEach((s) => must.add(s));
    else if (section === "nice") skills.forEach((s) => nice.add(s));
    if (!hasSections || section === "must") {
      const y = YEARS.exec(line);
      if (y?.[1]) {
        const n = Number(y[1]);
        if (n > 0 && n <= 30) minYears = minYears === null ? n : Math.min(minYears, n);
      }
    }
  }
  for (const s of must) nice.delete(s);

  return {
    mustHave: [...must].sort(),
    niceToHave: [...nice].sort(),
    minYears,
    seniority: inferSeniorityFromTitle(title),
    sponsorshipSignal: sponsorshipSignal(description),
    postingLanguage: detectLanguage(`${title}\n${description}`),
  };
}
