// Saves a resume the person has reviewed: every role, achievement, degree, project, certification
// and skill as confirmed facts, contact details into the answer bank (never over an answer they
// already gave), and languages. One transaction, so a failure leaves nothing half-saved.
// The file itself was read in the browser; only the reviewed text arrives here.
import { Hono } from "hono";
import { canonicalizeSkill, findSkills, inferCountry } from "@my-career-agent/core";
import type { AppBindings } from "./env.js";
import { stmt } from "./lib/tenant.js";

export const resumeImport = new Hono<AppBindings>();

const LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2", "native"]);
const FORMATS = new Set(["pdf", "docx", "tex", "text"]);
const CONTACT_KEYS: Record<string, string> = { name: "contact.full_name", email: "contact.email", phone: "contact.phone", location: "contact.location", linkedin: "contact.linkedin", website: "contact.website", github: "contact.website" };

type Obj = Record<string, unknown>;
const s = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
/** "2021" or "2021-03" → the first or last day it covers. */
function day(v: unknown, end: boolean): string | null {
  const t = s(v, 10);
  if (!t) return null;
  if (/^\d{4}$/.test(t)) return end ? `${t}-12-31` : `${t}-01-01`;
  const m = /^(\d{4})-(\d{2})$/.exec(t);
  if (!m) return null;
  if (!end) return `${t}-01`;
  const last = new Date(Date.UTC(+m[1]!, +m[2]!, 0)).getUTCDate();
  return `${t}-${String(last).padStart(2, "0")}`;
}

interface FactRow { kind: string; text: string; org: string | null; location: string | null; skills: string[]; startDate: string | null; endDate: string | null }

export function factsFrom(b: Obj): FactRow[] {
  const facts: FactRow[] = [];
  for (const raw of arr(b.experience, 40)) {
    const r = raw as Obj;
    const title = s(r.title, 200), org = s(r.org, 200);
    if (!title && !org) continue;
    const start = day(r.start, false), end = r.current === true ? null : day(r.end, true);
    facts.push({ kind: "role", text: title ?? "Role", org, location: s(r.location, 120), skills: [], startDate: start, endDate: end });
    for (const bullet of arr(r.bullets, 30)) {
      const t = s(bullet, 1000);
      if (t) facts.push({ kind: "achievement", text: t, org, location: null, skills: [], startDate: start, endDate: end });
    }
  }
  for (const raw of arr(b.education, 20)) {
    const e = raw as Obj;
    const degree = s(e.degree, 200), org = s(e.org, 200);
    if (!degree && !org) continue;
    facts.push({ kind: "education", text: degree ?? org!, org, location: s(e.location, 120), skills: [], startDate: day(e.start, false), endDate: day(e.end, true) });
  }
  for (const raw of arr(b.projects, 30)) {
    const p = raw as Obj;
    const name = s(p.name, 200);
    if (!name) continue;
    const bullets = arr(p.bullets, 20).map((x) => s(x, 1000)).filter(Boolean);
    const tech = arr(p.tech, 30).map((x) => s(x, 60)).filter((x): x is string => !!x);
    facts.push({ kind: "project", text: bullets.length ? `${name}: ${bullets.join(" ")}` : name, org: null, location: null, skills: tech, startDate: null, endDate: day(p.date, true) });
  }
  for (const raw of arr(b.certifications, 30)) {
    const c = raw as Obj;
    const name = s(c.name, 300);
    if (name) facts.push({ kind: "certification", text: name, org: null, location: null, skills: [], startDate: null, endDate: day(c.date, true) });
  }
  // Lines from sections the reader couldn't place (awards, volunteering) that the person chose to keep.
  for (const raw of arr(b.extra, 40)) {
    const t = s(raw, 1000);
    if (t) facts.push({ kind: "achievement", text: t, org: null, location: null, skills: [], startDate: null, endDate: null });
  }
  const skills = [...new Set(arr(b.skills, 150).map((x) => s(x, 60)).filter((x): x is string => !!x))];
  if (skills.length) facts.push({ kind: "skill", text: `Skills: ${skills.join(", ")}`, org: null, location: null, skills, startDate: null, endDate: null });
  // Skills as the scorer knows them: canonical names, and the ones each statement mentions.
  for (const f of facts) {
    const given = f.skills.map((x) => canonicalizeSkill(x));
    f.skills = [...new Set(given.length ? given : findSkills(`${f.text} ${f.org ?? ""}`))].slice(0, 50);
  }
  return facts;
}

resumeImport.post("/resume/import", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Obj | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the reviewed resume as JSON." }, 400);
  const format = s(b.format, 10) ?? "text";
  if (!FORMATS.has(format)) return c.json({ error: "format must be pdf, docx, tex or text" }, 400);
  const facts = factsFrom(b);
  if (!facts.length) return c.json({ error: "Nothing to save yet. Add at least one role, degree or skill." }, 400);
  const contact = (b.contact && typeof b.contact === "object" ? b.contact : {}) as Obj;
  const answers = Object.entries(CONTACT_KEYS)
    .map(([field, key]) => ({ key, answer: s(contact[field], 300) }))
    .filter((a): a is { key: string; answer: string } => !!a.answer)
    .filter((a, i, all) => all.findIndex((x) => x.key === a.key) === i);
  const languages = arr(b.languages, 20).map((x) => x as Obj)
    .map((l) => ({ language: s(l.language, 40)?.toLowerCase() ?? "", level: s(l.level, 6) ?? "" }))
    .filter((l) => l.language && LEVELS.has(l.level));
  const replace = b.replace === true;
  const home = inferCountry(s(contact.location, 120));
  const uid = c.get("userId");
  const counts = { facts: facts.length, roles: facts.filter((f) => f.kind === "role").length, answers: answers.length, languages: languages.length };

  await c.get("db").asUser(uid, [
    stmt(`INSERT INTO mca.app_user (user_id, home_country) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET home_country = coalesce(mca.app_user.home_country, EXCLUDED.home_country)`, uid, home),
    ...(replace ? [stmt(`DELETE FROM mca.fact WHERE source = 'resume'`)] : []),
    stmt(
      `INSERT INTO mca.fact (user_id, kind, text, org, location, skills, start_date, end_date, verified, source)
       SELECT $1, x.kind, x.text, x.org, x.location, x.skills, x."startDate", x."endDate", true, 'resume'
       FROM jsonb_to_recordset($2::jsonb) AS x(kind text, text text, org text, location text, skills text[], "startDate" date, "endDate" date)`,
      uid, JSON.stringify(facts),
    ),
    // Contact details fill empty answers only; anything the person typed stays.
    stmt(
      `INSERT INTO mca.answer_bank_entry (user_id, question_key, answer, sensitive, reviewed_at)
       SELECT $1, x.key, x.answer, false, now() FROM jsonb_to_recordset($2::jsonb) AS x(key text, answer text)
       ON CONFLICT (user_id, question_key) DO NOTHING`,
      uid, JSON.stringify(answers),
    ),
    stmt(
      `INSERT INTO mca.user_language (user_id, language, level)
       SELECT $1, x.language, x.level FROM jsonb_to_recordset($2::jsonb) AS x(language text, level text)
       ON CONFLICT (user_id, language) DO NOTHING`,
      uid, JSON.stringify(languages),
    ),
    stmt(`INSERT INTO mca.resume_import (user_id, file_name, format, counts) VALUES ($1, $2, $3, $4::jsonb)`, uid, s(b.fileName, 200), format, JSON.stringify(counts)),
  ]);
  const firstRole = facts.find((f) => f.kind === "role");
  return c.json({ ok: true, ...counts, suggestions: { targetTitle: firstRole?.text ?? null, homeCountry: home } }, 201);
});

/** Whether an earlier import exists, so the review screen can offer to replace it. */
resumeImport.get("/resume/import", async (c) => {
  const [rows = [], [n] = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT file_name, format, counts, created_at FROM mca.resume_import ORDER BY created_at DESC LIMIT 1`),
    stmt(`SELECT count(*)::int AS n FROM mca.fact WHERE source = 'resume'`),
  ]);
  return c.json({ last: rows[0] ?? null, importedFacts: Number(n?.n ?? 0) });
});
