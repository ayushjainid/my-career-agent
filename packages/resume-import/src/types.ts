// The shapes shared by every extractor and the structurer.

export type Source = "pdf" | "docx" | "tex" | "text";

/** Structured fields an extractor already knows, e.g. from a LaTeX macro's arguments. */
export interface EntryHint {
  org?: string;
  title?: string;
  location?: string;
  dates?: string;
  /** Free text beside the entry (a project's tech list, a grade). */
  extra?: string;
}

/** One visual line of the resume, in reading order. */
export interface Line {
  text: string;
  /** The line split where the layout puts space between pieces: a right-aligned date, a tab, a table cell. */
  parts: string[];
  /** Dominant font size in points (PDF, Word); 0 when unknown. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** Starts with a bullet glyph, or is a list item. */
  bullet: boolean;
  /** A structural heading: Word heading style, LaTeX \section, or a PDF line styled as one. */
  heading: boolean;
  /** x of the first character (PDF) or list depth (Word, LaTeX). */
  indent: number;
  /** Vertical space above this line, in multiples of its own height (PDF only; 0 elsewhere). */
  gapBefore: number;
  /** Font size of each part (PDF), so a large name beside a small phone number still reads as large. */
  partSizes?: number[];
  /** The line runs to its column's right edge, so text on the next line may be its continuation (PDF). */
  full?: boolean;
  /** Set when the source said exactly what this line is. */
  entry?: EntryHint;
  /** Set when the source tagged a contact field (LaTeX moderncv \email, \phone, …). */
  contact?: Partial<Record<ContactField, string>>;
}

export interface ExtractedDoc {
  source: Source;
  lines: Line[];
  /** Hyperlink targets found in the file (mailto:, https://linkedin.com/…). */
  links: string[];
  warnings: string[];
}

export type ContactField = "name" | "email" | "phone" | "location" | "linkedin" | "github" | "website" | "headline";

export type CEFR = "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | "native";

/** A year, or a year and month: "2021" or "2021-03". */
export type PartialDate = string;

export interface Role {
  title: string;
  org: string;
  location: string | null;
  start: PartialDate | null;
  end: PartialDate | null;
  current: boolean;
  bullets: string[];
  /** Fields the structurer had to guess; the review screen marks them. */
  unsure: Array<"title" | "org" | "dates">;
}

export interface Education {
  degree: string;
  org: string;
  location: string | null;
  start: PartialDate | null;
  end: PartialDate | null;
  details: string[];
  unsure: Array<"degree" | "org" | "dates">;
}

export interface Project {
  name: string;
  tech: string[];
  date: PartialDate | null;
  bullets: string[];
}

export interface Certification {
  name: string;
  date: PartialDate | null;
}

export interface LanguageSkill {
  language: string;
  level: CEFR;
}

export interface ParsedResume {
  source: Source;
  contact: Partial<Record<ContactField, string>>;
  summary: string | null;
  experience: Role[];
  education: Education[];
  projects: Project[];
  skills: string[];
  certifications: Certification[];
  languages: LanguageSkill[];
  /** Text the structurer couldn't place, so nothing is silently lost. */
  other: Array<{ heading: string; lines: string[] }>;
  warnings: string[];
}
