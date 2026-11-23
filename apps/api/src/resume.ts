// Beta loop B2 endpoint: a tailored resume for a job or a target role, as PDF, DOCX or JSON
// (the JSON carries the ATS text check, so the packet can show it before anyone downloads).

import { buildResume, checkResume, extractRequirements, resumeLines, type Fact, type JobRequirements, type ResumeContact } from "@my-career-agent/core";
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { stmt } from "./lib/tenant.js";
import { pdfSafe, resumeDocx, resumePdf } from "./resumeFiles.js";

export const resume = new Hono<AppBindings>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

resume.get("/resume", async (c) => {
  const jobId = c.req.query("jobId") ?? null;
  const targetId = c.req.query("targetId") ?? null;
  const format = (c.req.query("format") ?? "json").toLowerCase();
  if ((jobId && !UUID.test(jobId)) || (targetId && !UUID.test(targetId))) return c.json({ error: "bad id" }, 400);
  if (!["json", "pdf", "docx"].includes(format)) return c.json({ error: "format is json, pdf or docx" }, 400);

  const [facts = [], answers = [], jobs = [], targets = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT id, kind, text, org, skills, start_date::text AS start_date, end_date::text AS end_date, verified FROM mca.fact WHERE verified`),
    stmt(`SELECT question_key, answer FROM mca.answer_bank_entry WHERE question_key LIKE 'contact.%'`),
    jobId ? stmt(`SELECT j.title, j.description_text, j.requirements, co.name AS company FROM mca.job j JOIN mca.company co ON co.id = j.company_id WHERE j.id = $1`, jobId) : stmt(`SELECT 1 WHERE false`),
    stmt(`SELECT id, title FROM mca.target ORDER BY ($1::uuid IS NOT NULL AND id = $1::uuid) DESC, title LIMIT 1`, targetId),
  ]);
  const a = (k: string) => (answers.find((x) => x.question_key === `contact.${k}`)?.answer as string | undefined)?.trim() || null;
  const name = a("full_name");
  if (!name) return c.json({ error: "Add your full name in Settings > Answers first." }, 409);
  if (!facts.length) return c.json({ error: "Add and verify facts on your Profile first." }, 409);
  if (jobId && !jobs.length) return c.json({ error: "job not found" }, 404);

  const job = jobs[0];
  const req: JobRequirements | null = job
    ? ((job.requirements as JobRequirements | null)?.mustHave ? (job.requirements as JobRequirements) : extractRequirements(String(job.title), String(job.description_text ?? "")))
    : null;
  const title = job ? String(job.title) : ((targets[0]?.title as string | undefined) ?? null);
  const keywords = req ? [...req.mustHave, ...req.niceToHave] : [];
  const contact: ResumeContact = { name, email: a("email"), phone: a("phone"), location: a("location"), links: [a("linkedin"), a("website")].filter((x): x is string => !!x) };
  const factRows: Fact[] = facts.map((f) => ({
    id: String(f.id), kind: f.kind as Fact["kind"], text: String(f.text), org: (f.org as string | null) ?? null,
    skills: (f.skills as string[]) ?? [], startDate: (f.start_date as string | null) ?? null, endDate: (f.end_date as string | null) ?? null, verified: true,
  }));
  const doc = buildResume(contact, factRows, { title, keywords });
  const ascii = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = [ascii(name) || "Resume", "Resume", job ? ascii(String(job.company)) : ""].filter(Boolean).join("-");

  if (format === "docx") {
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    c.header("Content-Disposition", `attachment; filename="${base}.docx"`);
    return c.body(resumeDocx(doc) as Uint8Array<ArrayBuffer>);
  }
  const pdf = await resumePdf(doc);
  if (format === "pdf") {
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${base}.pdf"`);
    return c.body(pdf.bytes as Uint8Array<ArrayBuffer>);
  }
  // The PDF's standard fonts can't hold every character; check what the PDF really says and
  // warn when it had to fold something (the DOCX keeps the original).
  const folded = { ...doc, contact: { ...doc.contact, name: pdfSafe(doc.contact.name) },
    experience: doc.experience.map((r) => ({ ...r, org: r.org ? pdfSafe(r.org) : r.org })),
    education: doc.education.map((r) => ({ ...r, org: r.org ? pdfSafe(r.org) : r.org })) };
  const check = checkResume(folded, pdf.lines, pdf.pages, req?.mustHave ?? []);
  const changed = resumeLines(doc).filter((l) => pdfSafe(l) !== l);
  if (changed.length)
    check.issues.push({ code: "missing_required", severity: "warning",
      detail: `The PDF can't show some characters exactly (e.g. "${changed[0]!.slice(0, 60)}"). Use the DOCX where that matters.` });
  return c.json({ resume: doc, lines: resumeLines(doc), pages: pdf.pages, check, files: { base } });
});
