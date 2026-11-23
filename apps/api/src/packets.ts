// POC loop P5: the answer bank, free-text form answers, the apply packet and the tracker.
// A packet is plain data: the copy-assist page, an autofill tool or an AI agent can all use it.

import {
  DEFAULT_FIELD_LIMITS,
  STANDARD_QUESTIONS,
  isAnswerKey,
  isSensitiveKey,
  reviewField,
  type Fact,
  type FieldKind,
} from "@my-career-agent/core";
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { stmt, type Row } from "./lib/tenant.js";

export const packets = new Hono<AppBindings>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: FieldKind[] = ["self_intro", "project", "motivation", "short_answer", "other"];

const toFacts = (rows: Row[]): Fact[] =>
  rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as Fact["kind"],
    text: String(r.text),
    skills: (r.skills as string[]) ?? [],
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    verified: Boolean(r.verified),
  }));

const FACTS_SQL = `SELECT id, kind, text, skills, start_date::text AS start_date, end_date::text AS end_date, verified FROM mca.fact`;

// ---------- Answer bank ----------

/** Every saved answer, plus the standard questions still unanswered. */
packets.get("/answers", async (c) => {
  const [rows = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT question_key, answer, sensitive, reviewed_at FROM mca.answer_bank_entry ORDER BY question_key`),
  ]);
  const have = new Set(rows.map((r) => String(r.question_key)));
  return c.json({
    items: rows.map((r) => ({ ...r, label: STANDARD_QUESTIONS.find((q) => q.key === r.question_key)?.label ?? r.question_key })),
    missing: STANDARD_QUESTIONS.filter((q) => !have.has(q.key)),
  });
});

packets.put("/answers/:key", async (c) => {
  const key = c.req.param("key");
  if (!isAnswerKey(key)) return c.json({ error: "keys look like contact.email or us.work_authorized" }, 400);
  const b = await c.req.json<{ answer?: unknown; sensitive?: unknown }>().catch(() => null);
  const answer = typeof b?.answer === "string" ? b.answer.trim().slice(0, 4000) : "";
  if (!answer) return c.json({ error: "answer is required" }, 400);
  const uid = c.get("userId");
  await c.get("db").asUser(uid, [
    stmt(
      `INSERT INTO mca.answer_bank_entry (user_id, question_key, answer, sensitive, reviewed_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, question_key) DO UPDATE SET answer = EXCLUDED.answer, sensitive = EXCLUDED.sensitive, reviewed_at = now()`,
      uid, key, answer, isSensitiveKey(key, b?.sensitive === true),
    ),
  ]);
  return c.json({ ok: true });
});

packets.delete("/answers/:key", async (c) => {
  const key = c.req.param("key");
  if (!isAnswerKey(key)) return c.json({ error: "bad key" }, 400);
  const [rows = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`DELETE FROM mca.answer_bank_entry WHERE question_key = $1 RETURNING question_key`, key),
  ]);
  return rows.length ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ---------- Free-text answers for one application ----------

interface AnswerIn { label: string; kind: FieldKind; text: string; shortText?: string; citedFactIds: string[]; maxChars?: number; maxWords?: number }

function parseAnswer(raw: unknown): AnswerIn | string {
  const a = (raw ?? {}) as Record<string, unknown>;
  const label = typeof a.label === "string" ? a.label.trim().slice(0, 300) : "";
  const kind = a.kind as FieldKind;
  const text = typeof a.text === "string" ? a.text.slice(0, 10_000) : "";
  if (!label || !KINDS.includes(kind) || !text.trim()) return "each answer needs label, kind and text";
  const ids = Array.isArray(a.citedFactIds) ? a.citedFactIds.filter((x): x is string => typeof x === "string" && UUID.test(x)) : [];
  const lim = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 100_000 ? (v as number) : undefined);
  return {
    label, kind, text,
    shortText: typeof a.shortText === "string" && a.shortText.trim() ? a.shortText.slice(0, 10_000) : undefined,
    citedFactIds: [...new Set(ids)].slice(0, 30),
    maxChars: lim(a.maxChars), maxWords: lim(a.maxWords),
  };
}

const review = (a: AnswerIn, facts: Fact[]) =>
  reviewField(
    { label: a.label, kind: a.kind, text: a.text, shortText: a.shortText, citedFactIds: a.citedFactIds,
      limits: a.maxChars || a.maxWords ? { maxChars: a.maxChars, maxWords: a.maxWords } : undefined },
    facts,
  );

/** Check answers without saving: measured lengths, short variants, figures traced to facts. */
packets.post("/answers/review", async (c) => {
  const raw = await c.req.json<unknown>().catch(() => null);
  const list = Array.isArray(raw) ? raw : [raw];
  const parsed = list.map(parseAnswer);
  const bad = parsed.findIndex((p) => typeof p === "string");
  if (bad >= 0 || list.length > 30) return c.json({ error: bad >= 0 ? `answer ${bad}: ${parsed[bad]}` : "up to 30 answers" }, 400);
  const [facts = []] = await c.get("db").asUser(c.get("userId"), [stmt(FACTS_SQL)]);
  const f = toFacts(facts);
  return c.json({ items: (parsed as AnswerIn[]).map((a) => review(a, f)), defaults: DEFAULT_FIELD_LIMITS });
});

/** Replace an application's free-text answers. Frozen once the application is submitted. */
packets.put("/applications/:id/answers", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "bad application id" }, 400);
  const raw = await c.req.json<unknown>().catch(() => null);
  if (!Array.isArray(raw) || raw.length > 30) return c.json({ error: "send an array of up to 30 answers" }, 400);
  const parsed = raw.map(parseAnswer);
  const bad = parsed.findIndex((p) => typeof p === "string");
  if (bad >= 0) return c.json({ error: `answer ${bad}: ${parsed[bad]}` }, 400);
  const answers = parsed as AnswerIn[];
  const uid = c.get("userId");
  const db = c.get("db");
  const [apps = [], facts = []] = await db.asUser(uid, [stmt(`SELECT state FROM mca.application WHERE id = $1`, id), stmt(FACTS_SQL)]);
  if (!apps.length) return c.json({ error: "application not found" }, 404);
  if (!["queued", "approved", "ready_for_review", "failed"].includes(String(apps[0]?.state)))
    return c.json({ error: "answers are frozen once an application is submitted" }, 409);
  await db.asUser(uid, [
    stmt(`DELETE FROM mca.application_answer WHERE application_id = $1`, id),
    stmt(
      `INSERT INTO mca.application_answer (user_id, application_id, label, kind, text, short_text, cited_fact_ids, max_chars, max_words)
       SELECT $1, $2, x.label, x.kind, x.text, x."shortText", x."citedFactIds", x."maxChars", x."maxWords"
       FROM jsonb_to_recordset($3::jsonb) AS x(label text, kind text, text text, "shortText" text, "citedFactIds" uuid[], "maxChars" int, "maxWords" int)`,
      uid, id, JSON.stringify(answers),
    ),
  ]);
  const f = toFacts(facts);
  return c.json({ ok: true, items: answers.map((a) => review(a, f)) });
});

// ---------- Packet ----------

/**
 * Everything needed to fill one application. `ready` is false while any free-text answer is over
 * a stated limit or cites a figure no verified fact supports, or a sensitive answer is missing.
 */
packets.get("/packets/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!UUID.test(jobId)) return c.json({ error: "bad job id" }, 400);
  const [jobs = [], bank = [], apps = [], answers = [], facts = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT j.id, j.title, j.apply_url, j.ats_vendor, j.location_text, j.remote_type, j.pay_min, j.pay_max, j.pay_currency,
                 j.integrity, co.name AS company
          FROM mca.job j JOIN mca.company co ON co.id = j.company_id WHERE j.id = $1`, jobId),
    stmt(`SELECT question_key, answer, sensitive FROM mca.answer_bank_entry ORDER BY question_key`),
    stmt(`SELECT a.id, a.state, a.fit_score, a.gate_verdict, a.gates, a.notes, ct.full_name AS referral_name
          FROM mca.application a LEFT JOIN mca.contact ct ON ct.id = a.referral_contact_id WHERE a.job_id = $1`, jobId),
    stmt(`SELECT aa.label, aa.kind, aa.text, aa.short_text, aa.cited_fact_ids, aa.max_chars, aa.max_words
          FROM mca.application_answer aa JOIN mca.application a ON a.id = aa.application_id
          WHERE a.job_id = $1 ORDER BY aa.updated_at, aa.label`, jobId),
    stmt(FACTS_SQL),
  ]);
  const job = jobs[0];
  if (!job) return c.json({ error: "job not found" }, 404);
  const f = toFacts(facts);
  const reviewed = answers.map((a) => {
    const input: AnswerIn = {
      label: String(a.label), kind: a.kind as FieldKind, text: String(a.text),
      shortText: (a.short_text as string | null) ?? undefined,
      citedFactIds: ((a.cited_fact_ids as string[] | null) ?? []).map(String),
      maxChars: (a.max_chars as number | null) ?? undefined, maxWords: (a.max_words as number | null) ?? undefined,
    };
    return { ...input, review: review(input, f) };
  });
  const have = new Set(bank.map((b) => String(b.question_key)));
  const country = "us"; // POC: US pack only
  const missingSensitive = STANDARD_QUESTIONS.filter((q) => q.sensitive && q.key.startsWith(`${country}.`) && !have.has(q.key)).map((q) => q.label);
  const blockers = [
    ...reviewed.filter((a) => !a.review.ready).map((a) => `"${a.label}" needs fixing before it can be used`),
    ...missingSensitive.map((l) => `Answer bank is missing: ${l}`),
  ];
  const integrity = job.integrity as { level?: string; verdict?: string } | null;
  return c.json({
    job: { ...job, integrity: integrity ? { level: integrity.level, verdict: integrity.verdict } : null },
    application: apps[0] ?? null,
    fields: bank.map((b) => ({
      key: b.question_key,
      label: STANDARD_QUESTIONS.find((q) => q.key === b.question_key)?.label ?? b.question_key,
      value: b.answer,
      sensitive: b.sensitive,
    })),
    answers: reviewed,
    resume: null, // resume rendering is beta loop B2; attach your own file for now
    ready: blockers.length === 0,
    blockers,
    rules: [
      "Copy sensitive answers exactly; never let a tool rewrite them.",
      "Stop before submit. You review and submit every application yourself.",
    ],
  });
});

// ---------- Tracker ----------

/** Applications by state, newest activity first. */
packets.get("/applications", async (c) => {
  const state = c.req.query("state");
  const states = state ? state.split(",").filter((s) => /^[a-z_]+$/.test(s)).slice(0, 11) : null;
  const [rows = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(
      `SELECT a.id, a.state, a.planned_date::text AS planned_date, a.submitted_at, a.fit_score, a.gate_verdict,
              j.id AS job_id, j.title, j.apply_url, co.name AS company, ct.full_name AS referral_name,
              (SELECT max(created_at) FROM mca.application_event e WHERE e.application_id = a.id) AS last_event_at
       FROM mca.application a JOIN mca.job j ON j.id = a.job_id JOIN mca.company co ON co.id = j.company_id
       LEFT JOIN mca.contact ct ON ct.id = a.referral_contact_id
       WHERE $1::text[] IS NULL OR a.state = ANY ($1::text[])
       ORDER BY coalesce((SELECT max(created_at) FROM mca.application_event e WHERE e.application_id = a.id), a.created_at) DESC
       LIMIT 500`,
      states,
    ),
  ]);
  return c.json({ items: rows });
});
