// Lines → a structured resume. Deterministic: section headings by vocabulary and style, entries by
// layout, and fields by what each piece looks like (a date, a place, a job title, an organisation).
// Anything it has to guess is marked so the review screen can ask.
import { allDateSpans, findDateRange } from "./dates.js";
import type { CEFR, Certification, ContactField, Education, EntryHint, ExtractedDoc, LanguageSkill, Line, ParsedResume, Project, Role } from "./types.js";

type SectionKind = "experience" | "education" | "skills" | "projects" | "certifications" | "languages" | "summary" | "contact" | "other";

const SECTION_WORDS: Array<[SectionKind, string[]]> = [
  ["experience", ["experience", "work experience", "professional experience", "relevant experience", "employment", "employment history", "work history", "career history", "career", "professional background", "internships", "internship experience", "work", "berufserfahrung", "experience professionnelle", "experiences professionnelles", "expérience professionnelle", "expériences professionnelles", "experiencia", "experiencia laboral", "experiencia profesional", "werkervaring", "experiência", "experiência profissional"]],
  ["education", ["education", "academic background", "academics", "academic qualifications", "qualifications", "education and training", "education & training", "educational background", "ausbildung", "bildung", "formation", "formations", "educación", "formación", "opleiding", "educação", "formação"]],
  ["skills", ["skills", "technical skills", "core skills", "key skills", "skills & tools", "skills and tools", "skills & technologies", "skills and technologies", "competencies", "core competencies", "technologies", "tech stack", "tools", "tools & technologies", "expertise", "areas of expertise", "technical expertise", "programming", "kenntnisse", "fähigkeiten", "compétences", "habilidades", "vaardigheden", "competências", "skills summary"]],
  ["projects", ["projects", "personal projects", "selected projects", "side projects", "key projects", "academic projects", "open source", "open-source", "open source contributions", "projekte", "projets", "proyectos", "projecten", "projetos"]],
  ["certifications", ["certifications", "certificates", "certification", "licenses & certifications", "licenses and certifications", "licences & certifications", "licenses", "licences", "courses", "coursework", "training", "certifications & training", "zertifikate", "zertifizierungen", "certificaciones"]],
  ["languages", ["languages", "language skills", "language", "spoken languages", "sprachen", "sprachkenntnisse", "langues", "idiomas", "talen", "línguas"]],
  ["summary", ["summary", "profile", "professional summary", "career summary", "about", "about me", "objective", "career objective", "personal statement", "overview", "profil", "perfil", "über mich", "kurzprofil", "profiel"]],
  ["contact", ["contact", "contact information", "contact info", "contact details", "personal details", "personal information", "details", "kontakt", "contacto"]],
  ["other", ["awards", "honors", "honours", "awards & honors", "awards and honors", "achievements", "publications", "papers", "research", "volunteer", "volunteering", "volunteer experience", "leadership", "leadership experience", "activities", "extracurricular activities", "extracurriculars", "interests", "hobbies", "references", "patents", "talks", "conferences", "memberships", "affiliations", "additional information"]],
];
const SECTION_MAP = new Map<string, SectionKind>();
for (const [k, words] of SECTION_WORDS) for (const w of words) SECTION_MAP.set(w, k);

function sectionOf(text: string): SectionKind | null {
  const t = text.toLowerCase().replace(/[:：]\s*$/, "").replace(/\s+/g, " ").replace(/^[^\p{L}]+|[^\p{L}&)]+$/gu, "").trim();
  return SECTION_MAP.get(t) ?? SECTION_MAP.get(t.replace(/\s*&\s*/g, " and ")) ?? null;
}

const TITLE_WORDS = /\b(engineer|engineering|developer|programmer|architect|scientist|analyst|manager|director|lead|head|vp|vice president|president|ceo|cto|cfo|coo|cpo|founder|co-founder|cofounder|owner|consultant|advisor|adviser|specialist|associate|assistant|intern|internship|trainee|apprentice|designer|researcher|research assistant|fellow|professor|lecturer|teacher|tutor|officer|administrator|coordinator|technician|operator|representative|executive|strategist|recruiter|partner|principal|staff|senior|junior|sr\.?|jr\.?|sde|swe|devops|sre|qa|tester|writer|editor|accountant|auditor|nurse|physician|attorney|lawyer|paralegal|supervisor|contractor|freelance|freelancer|volunteer|student|ambassador|mentor|instructor|coach|agent|clerk|member|product owner|scrum master|werkstudent|praktikant|ingenieur|entwickler|stagiaire|ingénieur|desarrollador|ingeniero)\b/i;
const ORG_WORDS = /\b(inc|llc|ltd|limited|gmbh|ag|corp|corporation|company|co|plc|s\.?a|b\.?v|n\.?v|pvt|technologies|technology|tech|labs?|group|bank|university|universit[äéy]|college|institute|school|academy|polytechnic|solutions|systems|software|consulting|consultancy|partners|studio|studios|ventures|capital|health|hospital|clinic|foundation|agency|services|media|networks|games|government|ministry|department|council|club|society|association)\b/i;
const DEGREE_WORDS = /\b(b\.?\s?s\.?c?|b\.?\s?a|b\.?\s?eng|b\.?\s?tech|b\.?\s?e|m\.?\s?s\.?c?|m\.?\s?a|m\.?\s?eng|m\.?\s?tech|mba|ph\.?\s?d|d\.?\s?phil|bachelor'?s?|master'?s?|doctorate|doctor of|diploma|associate'?s? degree|associate of|certificate|a-levels?|gcse|high school|secondary school|hsc|ssc|licence|licenciatura|abitur|bsc|msc|beng|meng|btech|mtech|llb|llm|md|jd|degree|major|minor|honours|honors)\b/i;
const SCHOOL_WORDS = /\b(university|universit[äéy]|universidad|universidade|università|college|institute|institut|instituto|school|academy|polytechnic|hochschule|école|ecole|iit|nit|mit|ucla|epfl|eth)\b/i;
const COUNTRY = /\b(usa|u\.s\.a?\.?|us|united states|uk|u\.k\.|united kingdom|england|scotland|wales|ireland|canada|india|germany|deutschland|france|spain|españa|netherlands|nederland|belgium|switzerland|austria|italy|portugal|poland|sweden|norway|denmark|finland|australia|new zealand|singapore|japan|china|hong kong|taiwan|korea|south korea|brazil|brasil|mexico|méxico|argentina|chile|colombia|uae|united arab emirates|israel|turkey|türkiye|egypt|nigeria|kenya|south africa|pakistan|bangladesh|sri lanka|nepal|philippines|vietnam|indonesia|malaysia|thailand|remote)\b/i;
const US_STATE = /^(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|ON|BC|AB|QC|MB|NS|NB|SK)$/;

const LANGS = ["english", "spanish", "french", "german", "italian", "portuguese", "dutch", "russian", "ukrainian", "polish", "czech", "slovak", "hungarian", "romanian", "bulgarian", "serbian", "croatian", "bosnian", "slovenian", "greek", "turkish", "arabic", "hebrew", "persian", "farsi", "urdu", "hindi", "bengali", "bangla", "punjabi", "gujarati", "marathi", "tamil", "telugu", "kannada", "malayalam", "odia", "nepali", "sinhala", "mandarin", "chinese", "cantonese", "japanese", "korean", "vietnamese", "thai", "indonesian", "malay", "tagalog", "filipino", "swahili", "amharic", "yoruba", "igbo", "hausa", "zulu", "afrikaans", "swedish", "norwegian", "danish", "finnish", "icelandic", "estonian", "latvian", "lithuanian", "albanian", "macedonian", "georgian", "armenian", "azerbaijani", "kazakh", "uzbek", "catalan", "basque", "galician", "irish", "welsh", "latin", "sign language", "asl", "bsl", "deutsch", "englisch", "französisch", "spanisch", "italienisch", "russisch", "türkisch", "arabisch", "chinesisch", "polnisch", "niederländisch", "portugiesisch", "anglais", "français", "allemand", "espagnol", "italien", "arabe", "portugais", "néerlandais", "russe", "chinois", "inglés", "español", "francés", "alemán", "italiano", "portugués", "chino", "ruso", "nederlands", "engels", "duits", "frans", "português", "inglês", "polski"];
/** Language names written in another language, as the app stores them. */
const LANG_ALIASES: Record<string, string> = {
  deutsch: "German", englisch: "English", französisch: "French", spanisch: "Spanish", italienisch: "Italian", russisch: "Russian", türkisch: "Turkish", arabisch: "Arabic", chinesisch: "Chinese", polnisch: "Polish", niederländisch: "Dutch", portugiesisch: "Portuguese",
  anglais: "English", français: "French", allemand: "German", espagnol: "Spanish", italien: "Italian", arabe: "Arabic", portugais: "Portuguese", néerlandais: "Dutch", russe: "Russian", chinois: "Chinese",
  inglés: "English", español: "Spanish", francés: "French", alemán: "German", italiano: "Italian", portugués: "Portuguese", chino: "Chinese", ruso: "Russian",
  nederlands: "Dutch", engels: "English", duits: "German", frans: "French", português: "Portuguese", inglês: "English", polski: "Polish", farsi: "Persian", bangla: "Bengali", filipino: "Filipino", mandarin: "Mandarin Chinese",
};
const LANG_RE = new RegExp(`^(${LANGS.sort((a, b) => b.length - a.length).join("|")})\\b`, "i");

export function structure(doc: ExtractedDoc): ParsedResume {
  const lines = preprocess(doc.lines);
  const res: ParsedResume = { source: doc.source, contact: {}, summary: null, experience: [], education: [], projects: [], skills: [], certifications: [], languages: [], other: [], warnings: [...doc.warnings] };

  // Split into sections.
  const sections: Array<{ kind: SectionKind | "header"; heading: string; lines: Line[] }> = [{ kind: "header", heading: "", lines: [] }];
  const bodySize = typicalSize(lines);
  for (const l of lines) {
    const kind = !l.bullet && !l.entry && l.parts.length === 1 ? sectionOf(l.text) : null;
    const looksLikeHeading = l.heading || l.bold || isCaps(l.text) || (l.size > 0 && l.size >= bodySize * 1.05) || doc.source === "text" || l.text.split(/\s+/).length <= 3;
    if (kind && looksLikeHeading) { sections.push({ kind, heading: l.text, lines: [] }); continue; }
    sections[sections.length - 1]!.lines.push(l);
  }
  if (sections.length === 1) res.warnings.push("No section headings were recognised, so roles and skills may be incomplete. Check everything below.");

  for (const s of sections) {
    switch (s.kind) {
      case "header": case "contact": readContact(s.lines, res, s.kind === "header"); break;
      case "experience": res.experience.push(...readRoles(s.lines, doc)); break;
      case "education": res.education.push(...readEducation(s.lines, doc)); break;
      case "projects": res.projects.push(...readProjects(s.lines)); break;
      case "skills": res.skills.push(...readSkills(s.lines)); break;
      case "certifications": res.certifications.push(...readCertifications(s.lines)); break;
      case "languages": {
        const langs = readLanguages(s.lines);
        if (langs.length) res.languages.push(...langs);
        else res.skills.push(...readSkills(s.lines)); // "Languages: Python, Go" means programming languages
        break;
      }
      case "summary": res.summary = joinParagraph(s.lines); break;
      default: res.other.push({ heading: s.heading, lines: s.lines.map((l) => l.text) });
    }
  }
  // Contact details anywhere in the file (some templates put them in a footer or sidebar).
  fillContactFromAll(lines, doc.links, res);
  res.skills = dedupe(res.skills);
  res.languages = dedupeBy(res.languages, (l) => l.language.toLowerCase());
  if (!res.contact.name) res.warnings.push("Your name wasn't found. Add it below.");
  if (!res.experience.length) res.warnings.push("No roles were found. Add them below, or try another format of your resume.");
  return res;
}

// ---------------------------------------------------------------- preprocessing

const LONE_END = /^(present|current|now|today|heute|\d{1,2}\/\d{4}|(?:19|20)\d{2})$/i;
function preprocess(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const raw of lines) {
    const l: Line = { ...raw, parts: [...raw.parts], partSizes: raw.partSizes ? [...raw.partSizes] : undefined };
    const prev = out[out.length - 1];
    // A wrapped date column: "01/2022 –" then "present" at the start of the next line.
    const open = prev ? prev.parts.findIndex((p) => /\d\s*[–—-]\s*$/.test(p)) : -1;
    if (prev && open >= 0 && LONE_END.test(l.parts[0] ?? "")) {
      prev.parts[open] = `${prev.parts[open]} ${l.parts[0]}`;
      prev.text = prev.parts.join(" ");
      l.parts.shift(); l.partSizes?.shift();
      if (!l.parts.length) continue;
      l.text = l.parts.join(" ");
    }
    // A line that wrapped: the previous one ran to the right edge and this one carries on in the same style.
    if (prev && prev.full && prev.parts.length === 1 && l.parts.length === 1 && !l.bullet && !l.entry && !sectionOf(l.text) &&
        Math.abs(prev.indent - l.indent) <= 3 && l.gapBefore < 0.7 && prev.bold === l.bold && prev.italic === l.italic && !findDateRange(l.text) && !sectionOf(prev.text)) {
      prev.parts[0] = `${prev.parts[0]} ${l.text}`;
      prev.text = prev.parts[0]!;
      prev.full = l.full;
      continue;
    }
    out.push(l);
  }
  return out;
}
function typicalSize(lines: Line[]): number {
  const w = new Map<number, number>();
  for (const l of lines) if (l.size) w.set(l.size, (w.get(l.size) ?? 0) + l.text.length);
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}
const isCaps = (s: string) => s === s.toUpperCase() && /\p{Lu}{3}/u.test(s);

// ---------------------------------------------------------------- contact

const EMAIL = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/;
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[\w\-%.]+\/?/i;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i;
const WEBSITE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:dev|io|com|me|net|org|app|ai|co|xyz|site|page|tech|design|codes|info|blog|work|portfolio)(?:\/[\w\-./~#]*)?\b/i;

function phoneIn(s: string): string | null {
  for (const m of s.matchAll(/(?:\(\+\d{1,3}\)\s?|\+\s?\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d[\d\s.-]{6,16}\d/g)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    if (/^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$/.test(raw)) continue; // a year range
    return raw.replace(/\s+/g, " ");
  }
  return null;
}

function splitPieces(s: string): string[] {
  return s.split(/\s*[|•·◦▪♦⋄∙]\s*|\s{3,}|\t/).map((x) => x.trim()).filter(Boolean);
}

function looksLikePlace(s: string): boolean {
  if (/[@\d]/.test(s) || s.length > 48) return false;
  if (TITLE_WORDS.test(s) || ORG_WORDS.test(s) || SCHOOL_WORDS.test(s) || DEGREE_WORDS.test(s)) return /^remote\b/i.test(s);
  const bits = s.split(/\s*,\s*/);
  if (bits.length >= 2 && bits.length <= 3 && bits.every((b) => /^\p{Lu}[\p{L}.' -]*$/u.test(b) && b.split(/\s+/).length <= 3)) {
    const last = bits[bits.length - 1]!;
    // "City, ST" or "City, Country"; two capitalised words alone ("Hooli, Initech") could be anything.
    return US_STATE.test(last) || COUNTRY.test(last) || (bits.length === 2 && bits[0]!.split(/\s+/).length <= 2 && last.split(/\s+/).length <= 2 && !/\s/.test(last) === false);
  }
  return COUNTRY.test(s) && s.split(/\s+/).length <= 3;
}

function readContact(lines: Line[], res: ParsedResume, isHeader: boolean): void {
  const c = res.contact;
  const set = (k: ContactField, v: string | null | undefined) => { if (v && !c[k]) c[k] = v.trim(); };
  let nameIdx = -1;
  for (const l of lines) for (const [k, v] of Object.entries(l.contact ?? {})) set(k as ContactField, v);
  if (isHeader && !c.name) {
    // The name: the largest text near the top that reads like a name.
    const sizeOf = (l: Line) => l.partSizes?.[0] || l.size || 0;
    const candidates = lines.slice(0, 8).map((l, i) => ({ l, i })).filter(({ l }) => isName(l.parts[0] ?? ""));
    const best = candidates.sort((a, b) => sizeOf(b.l) - sizeOf(a.l) || a.i - b.i)[0];
    if (best) { set("name", tidyName(best.l.parts[0]!)); nameIdx = best.i; }
  }
  lines.forEach((l, i) => {
    for (const piece of l.parts.flatMap(splitPieces)) {
      const email = EMAIL.exec(piece)?.[0];
      if (email) { set("email", email); continue; }
      const li = LINKEDIN.exec(piece)?.[0];
      if (li) { set("linkedin", li); continue; }
      const gh = GITHUB.exec(piece)?.[0];
      if (gh) { set("github", gh); continue; }
      const ph = phoneIn(piece);
      if (ph && ph.replace(/\D/g, "").length >= 9 && piece.replace(ph, "").replace(/[^\p{L}]/gu, "").length < 12) { set("phone", ph); continue; }
      if (looksLikePlace(piece)) { set("location", piece); continue; }
      const site = WEBSITE.exec(piece)?.[0];
      if (site && !/@/.test(piece)) { set("website", site); continue; }
      if (isHeader && i !== nameIdx && !c.headline && piece.split(/\s+/).length <= 8 && !/\d/.test(piece) && TITLE_WORDS.test(piece)) set("headline", piece);
    }
  });
  // An address set on two lines: "London" then "United Kingdom".
  if (!c.location || COUNTRY.test(c.location) && !c.location.includes(",")) {
    for (let i = 0; i + 1 < lines.length; i++) {
      const a = lines[i]!.parts.length === 1 ? lines[i]!.parts[0]! : "", b = lines[i + 1]!.parts[0] ?? "";
      if (a && COUNTRY.test(b) && b.split(/\s+/).length <= 3 && /^\p{Lu}[\p{L}' -]+$/u.test(a) && a.split(/\s+/).length <= 3 && !isName(a) && i !== nameIdx) {
        c.location = `${a}, ${b}`;
        break;
      }
    }
  }
}

function isName(s: string): boolean {
  const words = s.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5 || /[\d@/:|]/.test(s)) return false;
  if (sectionOf(s) || TITLE_WORDS.test(s) && words.length > 2) return false;
  return words.every((w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w) || /^(de|da|van|von|der|den|del|la|le|bin|binti|al|el|di|du|dos|das)$/i.test(w));
}
function tidyName(s: string): string {
  if (s !== s.toUpperCase()) return s.trim();
  return s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()).trim();
}

function fillContactFromAll(lines: Line[], links: string[], res: ParsedResume): void {
  const c = res.contact;
  const all = lines.map((l) => l.text).join("\n");
  for (const u of links) {
    if (/^mailto:/i.test(u) && !c.email) c.email = u.replace(/^mailto:/i, "").split("?")[0];
    else if (/linkedin\.com\/(in|pub)\//i.test(u) && !c.linkedin) c.linkedin = u;
    else if (/github\.com\/[\w-]+/i.test(u) && !c.github) c.github = u.replace(/\/$/, "");
  }
  if (!c.email) c.email = EMAIL.exec(all)?.[0];
  if (!c.linkedin) c.linkedin = LINKEDIN.exec(all)?.[0];
  if (!c.github) c.github = GITHUB.exec(all)?.[0];
  if (!c.phone) for (const l of lines.slice(0, 40)) { const p = phoneIn(l.text); if (p && !findDateRange(p)) { c.phone = p; break; } }
  for (const k of ["linkedin", "github", "website"] as const) if (c[k]) c[k] = c[k]!.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  for (const k of Object.keys(c) as ContactField[]) if (!c[k]) delete c[k];
}

// ---------------------------------------------------------------- entries

interface Group { header: Line[]; body: Line[] }

/** Splits a section into entries: header lines (title, organisation, place, dates), then bullets. */
function groups(lines: Line[]): Group[] {
  const out: Group[] = [];
  let cur: Group | null = null;
  const words = (l: Line) => l.text.split(/\s+/).length;
  const dated = (l: Line) => !!l.entry?.dates || !!findDateRange(l.text);
  // A header line: says when, or is styled or laid out like a heading, or is a short name right above a dated line.
  const headerish = (l: Line, next: Line | undefined) =>
    !!l.entry || (dated(l) && words(l) <= 16) || (l.bold && words(l) <= 12) || (l.italic && words(l) <= 10) || (l.parts.length >= 2 && words(l) <= 14) ||
    (words(l) <= 6 && !/[.!?]$/.test(l.text) && !!next && !next.bullet && dated(next));
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    const isBody = l.bullet || !headerish(l, next) || (words(l) >= 16 && !l.entry && !dated(l));
    if (isBody) {
      if (!cur) { cur = { header: [], body: [] }; out.push(cur); }
      const last = cur.body[cur.body.length - 1];
      // A wrapped line that starts in lower case carries on the previous bullet.
      if (last && !l.bullet && /^[\p{Ll}\d(%&]/u.test(l.text) && !/[.!?]$/.test(last.text)) { last.text = `${last.text} ${l.text}`; return; }
      cur.body.push(l);
      return;
    }
    const startsNew = !cur || cur.body.length > 0 || !!l.entry || (hasDate(cur.header) && dated(l)) || cur.header.length >= 3;
    if (startsNew) { cur = { header: [l], body: [] }; out.push(cur); }
    else cur!.header.push(l);
  });
  return out.filter((g) => g.header.length || g.body.length);
}
const hasDate = (ls: Line[]) => ls.some((l) => l.entry?.dates || findDateRange(l.text));

interface Fields { title: string; org: string; location: string | null; start: string | null; end: string | null; current: boolean; extra: string[]; unsure: Set<string> }

/** Works out which header piece is the title, the organisation, the place and the dates. */
function fields(header: Line[], kind: "role" | "education", inheritOrg?: string): Fields {
  const f: Fields = { title: "", org: "", location: null, start: null, end: null, current: false, extra: [], unsure: new Set() };
  const hint: EntryHint = Object.assign({}, ...header.map((l) => l.entry ?? {}));
  const dateText = hint.dates ?? header.map((l) => l.text).find((t) => findDateRange(t)) ?? "";
  const range = findDateRange(dateText);
  if (range) { f.start = range.start; f.end = range.end; f.current = range.current; }
  if (hint.title || hint.org) {
    f.title = hint.title ?? "";
    f.org = hint.org ?? inheritOrg ?? "";
    f.location = hint.location ?? null;
    if (hint.extra) f.extra.push(hint.extra);
    if (!range) f.unsure.add("dates");
    return f;
  }
  // Pieces, with dates taken out.
  type Piece = { text: string; bold: boolean; italic: boolean; line: number; after?: Piece };
  let pieces: Piece[] = [];
  header.forEach((l, li) => {
    for (const part of l.parts) {
      let p = part;
      for (const d of allDateSpans(p)) p = p.replace(d, " ");
      p = p.replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ");
      for (const s of p.split(/\s+[|•·]\s+|\s+[–—]\s+|\s+-\s+|\s+@\s+|\s+at\s+(?=\p{Lu})/u)) {
        const t = s.trim().replace(/^[,;:|–—-]+|[,;:|–—-]+$/g, "").trim();
        if (t) pieces.push({ text: t, bold: l.bold, italic: l.italic, line: li });
      }
    }
  });
  // Comma lists: "Backend Engineer, Northwind Bank, London, UK".
  pieces = pieces.flatMap((p) => {
    if (!p.text.includes(",")) return [p];
    if (looksLikePlace(p.text)) return [p];
    const bits = p.text.split(/\s*,\s*/).filter(Boolean);
    // Keep a trailing "City, Country" together.
    const tail = bits.length >= 3 && looksLikePlace(bits.slice(-2).join(", ")) ? [bits.slice(-2).join(", ")] : [];
    const head = tail.length ? bits.slice(0, -2) : bits;
    const made = [...head, ...tail].map((t) => ({ ...p, text: t }) as Piece);
    made.forEach((m, k) => { if (k) m.after = made[k - 1]; });
    return made;
  });
  const place = pieces.find((p) => looksLikePlace(p.text));
  if (place) { f.location = place.text; pieces = pieces.filter((p) => p !== place); }
  const isA = kind === "role" ? (s: string) => TITLE_WORDS.test(s) : (s: string) => DEGREE_WORDS.test(s);
  const isB = kind === "role" ? (s: string) => ORG_WORDS.test(s) : (s: string) => SCHOOL_WORDS.test(s);
  const score = (p: Piece) => (isA(p.text) ? 2 : 0) - (isB(p.text) ? 2 : 0) + (p.italic ? 1 : 0) - (p.bold ? 1 : 0);
  if (pieces.length === 1) {
    if (isA(pieces[0]!.text) && !isB(pieces[0]!.text)) { f.title = pieces[0]!.text; f.org = inheritOrg ?? ""; if (!inheritOrg) f.unsure.add("org"); }
    else { f.org = pieces[0]!.text; f.unsure.add("title"); }
  } else if (pieces.length >= 2) {
    const ranked = [...pieces].sort((a, b) => score(b) - score(a));
    const top = ranked[0]!, bottom = ranked[ranked.length - 1]!;
    if (score(top) === score(bottom)) {
      // Nothing tells them apart: "Title, Company" is the most common order.
      f.title = pieces[0]!.text; f.org = pieces[1]!.text; f.unsure.add("title"); f.unsure.add("org");
    } else {
      f.title = top.text;
      const rest = pieces.filter((p) => p !== top);
      const orgPiece = rest.find((p) => isB(p.text)) ?? rest.find((p) => p.bold) ?? rest[0]!;
      f.org = orgPiece.text;
      for (const p of rest) if (p !== orgPiece) {
        // "Bachelor of Design, Interaction Design": the field of study follows the degree.
        if (kind === "education" && p.after === top && !looksLikePlace(p.text)) { f.title = `${f.title}, ${p.text}`; continue; }
        // A short capitalised leftover next to the place is usually more of the place ("New Delhi").
        if (!f.location && p.text.split(/\s+/).length <= 3 && /^\p{Lu}/u.test(p.text) && !isA(p.text) && !isB(p.text)) f.location = p.text;
        else f.extra.push(p.text);
      }
      if (!isA(top.text) && !top.italic) f.unsure.add("title");
    }
  }
  if (!range) f.unsure.add("dates");
  return f;
}

function readRoles(lines: Line[], doc: ExtractedDoc): Role[] {
  const roles: Role[] = [];
  for (const g of groups(lines)) {
    if (!g.header.length) {
      // Bullets before any header: attach to the previous role, or keep them as an untitled role.
      if (roles.length) roles[roles.length - 1]!.bullets.push(...g.body.map((l) => l.text));
      else roles.push({ title: "", org: "", location: null, start: null, end: null, current: false, bullets: g.body.map((l) => l.text), unsure: ["title", "org", "dates"] });
      continue;
    }
    const inherit = g.header[0]!.entry && !g.header[0]!.entry!.org ? roles[roles.length - 1]?.org : undefined;
    const f = fields(g.header, "role", inherit);
    roles.push({
      title: f.title, org: f.org, location: f.location, start: f.start, end: f.end, current: f.current,
      bullets: [...f.extra.filter((x) => x.split(/\s+/).length > 6), ...g.body.map((l) => l.text)],
      unsure: [...f.unsure] as Role["unsure"],
    });
  }
  void doc;
  return roles.filter((r) => r.title || r.org || r.bullets.length);
}

function readEducation(lines: Line[], doc: ExtractedDoc): Education[] {
  void doc;
  return groups(lines).filter((g) => g.header.length).map((g) => {
    const f = fields(g.header, "education");
    const unsure = [...f.unsure].map((u) => (u === "title" ? "degree" : u)) as Education["unsure"];
    return { degree: f.title, org: f.org, location: f.location, start: f.start, end: f.end, details: [...f.extra, ...g.body.map((l) => l.text)], unsure };
  });
}

function readProjects(lines: Line[]): Project[] {
  const out: Project[] = [];
  for (const g of groups(lines)) {
    const h = g.header[0];
    if (!h) { if (out.length) out[out.length - 1]!.bullets.push(...g.body.map((l) => l.text)); continue; }
    const text = h.entry?.title ?? h.parts[0] ?? h.text;
    const range = findDateRange(h.entry?.dates ?? h.text);
    const [name, ...techBits] = text.split(/\s+[|–—]\s+|\s*\|\s*/);
    let cleanName = (name ?? "").trim();
    let tech = techBits.join(", ");
    const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(cleanName);
    if (!tech && paren && paren[2]!.includes(",")) { cleanName = paren[1]!; tech = paren[2]!; }
    for (const d of allDateSpans(cleanName)) cleanName = cleanName.replace(d, "").trim();
    out.push({
      name: cleanName.replace(/[,:–—-]+$/, "").trim(),
      tech: splitSkills(tech),
      date: range?.end ?? range?.start ?? null,
      bullets: [...g.header.slice(1).map((l) => l.text), ...g.body.map((l) => l.text)],
    });
  }
  return out.filter((p) => p.name);
}

function readSkills(lines: Line[]): string[] {
  return lines.flatMap((l) => {
    const parts = l.parts.length > 1 && l.parts[0]!.split(/\s+/).length <= 3 && !l.parts[0]!.includes(",") ? l.parts.slice(1) : l.parts;
    return parts.flatMap((p) => splitSkills(p.replace(/^[\p{L}][\p{L} &/+#.-]{1,30}:\s*/u, "")));
  });
}
function splitSkills(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;•·|]/.test(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.flatMap((x) => x.split(/\s+\/\s+|\s{2,}/)).map((x) => x.trim().replace(/^(?:and|&)\s+/i, "").replace(/\.$/, "")).filter((x) => x && x.length <= 40 && !/^(and|etc)$/i.test(x));
}

function readCertifications(lines: Line[]): Certification[] {
  return lines.map((l) => {
    const range = findDateRange(l.text);
    let name = l.text;
    if (range) name = name.replace(range.matched, "");
    name = name.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s*[|,–—-]\s*$/, "").replace(/\s{2,}/g, " ").trim();
    return { name, date: range ? range.end ?? range.start : null };
  }).filter((c) => c.name.length >= 3);
}

const LEVELS: Array<[RegExp, CEFR]> = [
  [/\b(native|mother tongue|first language|muttersprache|langue maternelle|nativo|nativa|lengua materna|moedertaal|bilingual)\b/i, "native"],
  [/\bC2\b|\b(proficient|full professional|near native|near-native|verhandlungssicher|courant|fluent|fluency|fließend)\b/i, "C2"],
  [/\bC1\b|\b(advanced|professional working|professional|sehr gut|avancé|avanzado)\b/i, "C1"],
  [/\bB2\b|\b(upper intermediate|upper-intermediate|good|gut|limited working)\b/i, "B2"],
  [/\bB1\b|\b(intermediate|conversational|working knowledge|intermédiaire|intermedio)\b/i, "B1"],
  [/\bA2\b|\b(elementary|basic|grundkenntnisse|basique|básico)\b/i, "A2"],
  [/\bA1\b|\b(beginner|notions|débutant|principiante)\b/i, "A1"],
];
function readLanguages(lines: Line[]): LanguageSkill[] {
  const items = lines.map((l) => l.parts.join(" ")).flatMap((p) => p.split(/\s*[,;•·|]\s*(?![^()]*\))/)).map((x) => x.trim()).filter(Boolean);
  const out: LanguageSkill[] = [];
  for (const it of items) {
    const m = LANG_RE.exec(it);
    if (!m) continue;
    const rest = it.slice(m[0].length);
    const level = LEVELS.find(([re]) => re.test(rest))?.[1] ?? "B2";
    const key = m[1]!.toLowerCase();
    const name = LANG_ALIASES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
    out.push({ language: name === "Asl" || name === "Bsl" ? name.toUpperCase() : name, level });
  }
  return out;
}

function joinParagraph(lines: Line[]): string | null {
  const t = lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
  return t || null;
}
function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
