// POC loop P2 (profile) and P3 (queue) endpoints. Everything goes through TenantDb, so the same
// handlers run against Neon in production and against the real migrations in tests.

import { COUNTRY_INFO, LANGUAGE_LEVELS, canonicalizeSkill, findSkills, isoDate, normalizeCountry, type Seniority } from "@my-career-agent/core";
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { startJobs } from "./lib/jobs.js";
import { stmt } from "./lib/tenant.js";
import { runQueueForUser } from "./queue.js";
import { payBenchmarks } from "./timingApi.js";
import { dailyLimit } from "./billing.js";

export const profile = new Hono<AppBindings>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FACT_KINDS = ["role", "achievement", "skill", "education", "certification", "project", "language"];
const SENIORITIES: Seniority[] = ["entry", "mid", "senior", "lead", "executive"];
const STATUSES = ["citizen", "permanent_resident", "work_visa", "needs_sponsorship"];

type Body = Record<string, unknown>;
const body = async (c: { req: { json: <T>() => Promise<T> } }): Promise<Body> => {
  const b = await c.req.json<unknown>().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : {};
};
const str = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const dateOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
const intIn = (v: unknown, lo: number, hi: number): number | undefined =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : undefined;

/** Create or update the user's settings. Must exist before anything else is stored. */
profile.put("/profile", async (c) => {
  const b = await body(c);
  const home = b.homeCountry === undefined ? null : str(b.homeCountry, 2)?.toUpperCase() ?? null;
  if (home !== null && !COUNTRY.test(home)) return c.json({ error: "homeCountry must be a 2-letter code" }, 400);
  const daily = b.dailyTarget === undefined ? 10 : intIn(b.dailyTarget, 0, 20);
  if (daily === undefined) return c.json({ error: "dailyTarget must be 0-20" }, 400);
  const maxActive = b.maxActiveProcesses === undefined ? 8 : intIn(b.maxActiveProcesses, 1, 30);
  if (maxActive === undefined) return c.json({ error: "maxActiveProcesses must be 1-30" }, 400);
  const window = b.offerWindowStart === undefined ? null : dateOrNull(b.offerWindowStart);
  if (window === undefined) return c.json({ error: "offerWindowStart must be YYYY-MM-DD or null" }, 400);

  const uid = c.get("userId");
  await c.get("db").asUser(uid, [
    stmt(
      `INSERT INTO mca.app_user (user_id, home_country, daily_target, max_active_processes, offer_window_start)
       VALUES ($1, $2, $3, $4, $5::date)
       ON CONFLICT (user_id) DO UPDATE SET home_country = EXCLUDED.home_country, daily_target = EXCLUDED.daily_target,
         max_active_processes = EXCLUDED.max_active_processes, offer_window_start = EXCLUDED.offer_window_start`,
      uid, home, daily, maxActive, window,
    ),
  ]);
  return c.json({ ok: true });
});

profile.get("/profile", async (c) => {
  const uid = c.get("userId");
  const [u, facts, langs, auth, targets] = await c.get("db").asUser(uid, [
    stmt(`SELECT home_country, daily_target, max_active_processes, offer_window_start::text AS offer_window_start FROM mca.app_user`),
    stmt(`SELECT count(*)::int AS n, count(*) FILTER (WHERE verified)::int AS verified FROM mca.fact`),
    stmt(`SELECT language, level FROM mca.user_language ORDER BY language`),
    stmt(`SELECT country, status, visa_type, min_lca_filings, min_perm_certified FROM mca.work_auth ORDER BY country`),
    stmt(`SELECT id, country, title, seniority, pay_floor, pay_currency FROM mca.target ORDER BY title`),
  ]);
  if (!u?.length) return c.json({ error: "no profile yet: PUT /api/profile first" }, 404);
  return c.json({ settings: u[0], facts: facts?.[0], languages: langs, workAuth: auth, targets });
});

// ---------- Facts (F1) ----------

interface FactIn { kind: string; text: string; org: string | null; skills: string[]; startDate: string | null; endDate: string | null; verified: boolean }

function parseFact(raw: unknown): FactIn | string {
  if (!raw || typeof raw !== "object") return "each fact must be an object";
  const f = raw as Body;
  const kind = str(f.kind, 20);
  if (!kind || !FACT_KINDS.includes(kind)) return `kind must be one of ${FACT_KINDS.join(", ")}`;
  const text = str(f.text, 2000);
  if (!text) return "text is required";
  const start = f.startDate === undefined ? null : dateOrNull(f.startDate);
  const end = f.endDate === undefined ? null : dateOrNull(f.endDate);
  if (start === undefined || end === undefined) return "dates must be YYYY-MM-DD";
  if (start && end && end < start) return "endDate is before startDate";
  const given = Array.isArray(f.skills)
    ? [...new Set(f.skills.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => canonicalizeSkill(s.trim().slice(0, 60))))].slice(0, 50)
    : [];
  // No skills given (e.g. a statement split from a pasted resume): take the ones the statement names.
  const skills = given.length ? given : findSkills(text).slice(0, 50);
  return { kind, text, org: str(f.org, 200), skills, startDate: start, endDate: end, verified: f.verified === true };
}

/** Add facts in bulk (up to 200). New facts are unverified unless the user marks them verified. */
profile.post("/facts", async (c) => {
  const raw = await c.req.json<unknown>().catch(() => null);
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [(raw as Body)] : [];
  if (!list.length || list.length > 200) return c.json({ error: "send 1-200 facts" }, 400);
  const parsed = list.map(parseFact);
  const bad = parsed.findIndex((p) => typeof p === "string");
  if (bad >= 0) return c.json({ error: `fact ${bad}: ${parsed[bad]}` }, 400);
  const uid = c.get("userId");
  const [rows] = await c.get("db").asUser(uid, [
    stmt(
      `INSERT INTO mca.fact (user_id, kind, text, org, skills, start_date, end_date, verified)
       SELECT $1, x.kind, x.text, x.org, x.skills, x."startDate", x."endDate", x.verified
       FROM jsonb_to_recordset($2::jsonb) AS x(kind text, text text, org text, skills text[], "startDate" date, "endDate" date, verified boolean)
       RETURNING id`,
      uid, JSON.stringify(parsed),
    ),
  ]);
  return c.json({ ok: true, ids: (rows ?? []).map((r) => r.id) }, 201);
});

profile.get("/facts", async (c) => {
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT id, kind, text, org, location, source, lang, translations, skills, start_date::text AS start_date, end_date::text AS end_date, verified
          FROM mca.fact ORDER BY start_date DESC NULLS LAST, created_at`),
  ]);
  return c.json({ items: rows });
});

/** Verify or edit a fact. Editing the text of a verified fact un-verifies it. */
profile.patch("/facts/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "bad fact id" }, 400);
  const b = await body(c);
  const text = b.text === undefined ? null : str(b.text, 2000);
  if (b.text !== undefined && !text) return c.json({ error: "text cannot be empty" }, 400);
  if (b.verified !== undefined && typeof b.verified !== "boolean") return c.json({ error: "verified must be true or false" }, 400);
  const verified = b.verified === undefined ? null : (b.verified as boolean);
  // Translations: { it: "..." } sets the Italian wording, { it: null } removes it. Other languages keep theirs.
  let translations: Record<string, string | null> | null = null;
  if (b.translations !== undefined) {
    if (!b.translations || typeof b.translations !== "object") return c.json({ error: "translations must be an object like { it: \"...\" }" }, 400);
    translations = {};
    for (const [k, v] of Object.entries(b.translations as Record<string, unknown>)) {
      if (!["en", "it"].includes(k)) return c.json({ error: "translations are en or it" }, 400);
      if (v !== null && (typeof v !== "string" || v.length > 2000)) return c.json({ error: "a translation is text up to 2,000 characters" }, 400);
      translations[k] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
  }
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(
      `UPDATE mca.fact SET text = coalesce($2, text),
         verified = CASE WHEN $3::boolean IS NOT NULL THEN $3::boolean WHEN $2::text IS NOT NULL THEN false ELSE verified END,
         translations = CASE WHEN $4::jsonb IS NULL THEN translations
                             ELSE jsonb_strip_nulls(translations || $4::jsonb) END
       WHERE id = $1 RETURNING id, verified, translations`,
      id, text, verified, translations ? JSON.stringify(translations) : null,
    ),
  ]);
  if (!rows?.length) return c.json({ error: "fact not found" }, 404);
  return c.json({ ok: true, fact: rows[0] });
});

profile.delete("/facts/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "bad fact id" }, 400);
  const [rows] = await c.get("db").asUser(c.get("userId"), [stmt(`DELETE FROM mca.fact WHERE id = $1 RETURNING id`, id)]);
  return rows?.length ? c.json({ ok: true }) : c.json({ error: "fact not found" }, 404);
});

// ---------- Languages, work authorization, targets ----------

/** Replace the declared languages. Levels: A1-C2 or native. */
profile.put("/languages", async (c) => {
  const raw = await c.req.json<unknown>().catch(() => null);
  if (!Array.isArray(raw) || raw.length > 20) return c.json({ error: "send an array of up to 20 {language, level}" }, 400);
  const items: Array<{ language: string; level: string }> = [];
  for (const r of raw) {
    const language = str((r as Body)?.language, 40)?.toLowerCase();
    const level = (r as Body)?.level;
    if (!language || typeof level !== "string" || !(level in LANGUAGE_LEVELS)) return c.json({ error: "each item needs language and a level A1-C2 or native" }, 400);
    items.push({ language, level });
  }
  const uid = c.get("userId");
  await c.get("db").asUser(uid, [
    stmt(`DELETE FROM mca.user_language`),
    stmt(
      `INSERT INTO mca.user_language (user_id, language, level)
       SELECT DISTINCT ON (x.language) $1, x.language, x.level FROM jsonb_to_recordset($2::jsonb) AS x(language text, level text)`,
      uid, JSON.stringify(items),
    ),
  ]);
  return c.json({ ok: true, count: new Set(items.map((i) => i.language)).size });
});

profile.put("/work-auth/:country", async (c) => {
  const country = normalizeCountry(c.req.param("country")) ?? "";
  if (!COUNTRY.test(country)) return c.json({ error: "country must be a 2-letter code" }, 400);
  const b = await body(c);
  const status = str(b.status, 30);
  if (!status || !STATUSES.includes(status)) return c.json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
  const defaults = COUNTRY_INFO[country as keyof typeof COUNTRY_INFO]?.defaults ?? { minFilings: 0, minPermCertified: 0 };
  const minLca = b.minLcaFilings === undefined ? defaults.minFilings : intIn(b.minLcaFilings, 0, 10_000);
  const minPerm = b.minPermCertified === undefined ? defaults.minPermCertified : intIn(b.minPermCertified, 0, 10_000);
  if (minLca === undefined || minPerm === undefined) return c.json({ error: "thresholds must be whole numbers" }, 400);
  const uid = c.get("userId");
  await c.get("db").asUser(uid, [
    stmt(
      `INSERT INTO mca.work_auth (user_id, country, status, visa_type, needs_new_cap_petition, min_lca_filings, min_perm_certified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, country) DO UPDATE SET status = EXCLUDED.status, visa_type = EXCLUDED.visa_type,
         needs_new_cap_petition = EXCLUDED.needs_new_cap_petition, min_lca_filings = EXCLUDED.min_lca_filings,
         min_perm_certified = EXCLUDED.min_perm_certified`,
      uid, country, status, str(b.visaType, 40), b.needsNewCapPetition === true, minLca, minPerm,
    ),
  ]);
  return c.json({ ok: true });
});

profile.post("/targets", async (c) => {
  const b = await body(c);
  const country = normalizeCountry(str(b.country, 2));
  const title = str(b.title, 120);
  if (!country || !COUNTRY.test(country) || !title) return c.json({ error: "country (2 letters) and title are required" }, 400);
  const seniority = b.seniority === undefined || b.seniority === null ? null : (b.seniority as Seniority);
  if (seniority !== null && !SENIORITIES.includes(seniority)) return c.json({ error: "invalid seniority" }, 400);
  const payFloor = b.payFloor === undefined || b.payFloor === null ? null : Number(b.payFloor);
  if (payFloor !== null && !(payFloor > 0 && payFloor < 10_000_000)) return c.json({ error: "invalid payFloor" }, 400);
  const currency = str(b.payCurrency, 3)?.toUpperCase() ?? null;
  if (payFloor !== null && !currency) return c.json({ error: "payCurrency is required with payFloor" }, 400);
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(
      `INSERT INTO mca.target (user_id, country, title, seniority, pay_floor, pay_currency)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      c.get("userId"), country, title, seniority, payFloor, currency,
    ),
  ]);
  return c.json({ ok: true, id: rows?.[0]?.id }, 201);
});

profile.delete("/targets/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "bad target id" }, 400);
  const [rows] = await c.get("db").asUser(c.get("userId"), [stmt(`DELETE FROM mca.target WHERE id = $1 RETURNING id`, id)]);
  return rows?.length ? c.json({ ok: true }) : c.json({ error: "target not found" }, 404);
});

/** Companies the user has tiered or blocked. */
profile.get("/preferences", async (c) => {
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT p.company_id, c.name, p.tier, p.block_mode, p.block_reason, p.block_expires_at::text AS block_expires_at
          FROM mca.company_preference p JOIN mca.company c ON c.id = p.company_id ORDER BY c.name`),
  ]);
  return c.json({ items: rows });
});

/** Find companies in the shared catalog (for tiers and the blacklist). */
profile.get("/companies", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return c.json({ error: "q must be at least 2 characters" }, 400);
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(
      `SELECT c.id, c.name, c.domain, c.ats_vendor, p.tier, p.block_mode
       FROM mca.company c LEFT JOIN mca.company_preference p ON p.company_id = c.id
       WHERE c.name ILIKE '%' || $1 || '%' OR c.domain ILIKE '%' || $1 || '%'
       ORDER BY c.name LIMIT 25`,
      q.replace(/[%_\\]/g, (m) => `\\${m}`),
    ),
  ]);
  return c.json({ items: rows });
});

// ---------- Daily queue (P3) ----------

/**
 * Fetch new jobs and rebuild this user's queue now. The work runs as a GitHub Actions job
 * (jobs.yml): the Workers free plan allows 10 ms of CPU, and fetching one large job board takes
 * ~850 ms. Asking again within REFRESH_COOLDOWN_SECONDS joins the run already on its way.
 */
export const REFRESH_COOLDOWN_SECONDS = 180;
profile.post("/queue/refresh", async (c) => {
  const uid = c.get("userId");
  const db = c.get("db");
  const [[u] = []] = await db.asUser(uid, [
    stmt(`SELECT queue_requested_at, now() - queue_requested_at < make_interval(secs => $1) AS recent FROM mca.app_user`, REFRESH_COOLDOWN_SECONDS),
  ]);
  if (!u) return c.json({ error: "add a profile and at least one target first" }, 409);
  if (u.recent) return c.json({ started: false, requestedAt: u.queue_requested_at });
  if (!c.env.GITHUB_DISPATCH_TOKEN || !c.env.GITHUB_REPO)
    return c.json({ error: "Fetching on demand isn't set up yet: add the GH_DISPATCH_TOKEN secret (see DEPLOY.md). New jobs still arrive every 3 hours." }, 503);
  const r = await startJobs(c.env, { user_id: uid });
  if (r.status !== 204) {
    console.error(JSON.stringify({ event: "dispatch_failed", status: r.status }));
    return c.json({ error: `GitHub didn't start the job (HTTP ${r.status}). Check the GH_DISPATCH_TOKEN secret.` }, 502);
  }
  const [[row] = []] = await db.asUser(uid, [stmt(`UPDATE mca.app_user SET queue_requested_at = now() RETURNING queue_requested_at`)]);
  return c.json({ started: true, requestedAt: row?.queue_requested_at });
});

/** Progress for the page: when the user asked, and the latest queue run. */
profile.get("/queue/refresh", async (c) => {
  // Compared in SQL: timestamps keep their microseconds there.
  const [[u] = [], [run] = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT queue_requested_at FROM mca.app_user`),
    stmt(`SELECT r.created_at, r.queued, jsonb_array_length(r.held_back) AS held_back, jsonb_array_length(r.excluded) AS excluded, r.note,
                 (u.queue_requested_at IS NULL OR r.created_at >= u.queue_requested_at) AS fresh
          FROM mca.queue_run r CROSS JOIN mca.app_user u ORDER BY r.created_at DESC LIMIT 1`),
  ]);
  const requestedAt = (u?.queue_requested_at as string | Date | null) ?? null;
  const done = !!run && run.fresh === true;
  return c.json({
    requestedAt,
    done,
    run: run ? { at: run.created_at, queued: run.queued, heldBack: run.held_back, excluded: run.excluded, note: run.note } : null,
  });
});

/** Build today's queue now (the nightly job runs the same function). Safe to repeat. */
profile.post("/queue/build", async (c) => {
  const today = new Date();
  const result = await runQueueForUser(c.get("db"), c.get("userId"), today, await dailyLimit(c.env, c.get("db"), c.get("userId")));
  if (!result) return c.json({ error: "add a profile and at least one target first" }, 409);
  return c.json({ date: isoDate(today), queued: result.queue.length, heldBack: result.heldBack.length, excluded: result.excluded.length, note: result.note });
});

/** Today's queue: everything planned up to today and not yet acted on, best first. */
profile.get("/queue", async (c) => {
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT a.id, a.state, a.planned_date::text AS planned_date, a.fit_score, a.rank_score, a.gate_verdict, a.notes,
                 j.id AS job_id, j.title, j.location_text, j.remote_type, j.apply_url,
                 j.pay_min, j.pay_max, j.pay_currency, j.integrity->>'level' AS integrity, c.name AS company, c.id AS company_id,
                 (SELECT count(*) FROM mca.contact ct WHERE ct.company_id = j.company_id)::int AS contacts,
                 rc.full_name AS referral_name
          FROM mca.application a
          JOIN mca.job j ON j.id = a.job_id
          JOIN mca.company c ON c.id = j.company_id
          LEFT JOIN mca.contact rc ON rc.id = a.referral_contact_id
          WHERE a.planned_date <= current_date AND a.state IN ('queued','approved','ready_for_review')
          ORDER BY a.planned_date, a.rank_score DESC NULLS LAST`),
  ]);
  const items = rows ?? [];
  const pay = await payBenchmarks(c.get("db"), c.get("userId"), items.map((r) => ({ companyId: String(r.company_id), title: String(r.title) })));
  return c.json({ items: items.map((r) => ({ ...r, pay_benchmark: pay.get(`${r.company_id}|${r.title}`) ?? null })) });
});

/** What the builder did on a day, including every excluded job and its reason. */
profile.get("/queue/runs/:date", async (c) => {
  const date = c.req.param("date");
  if (!DATE.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const [rows] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT run_date::text AS run_date, builder, queued, held_back, excluded, note FROM mca.queue_run WHERE run_date = $1::date`, date),
  ]);
  return rows?.length ? c.json(rows[0]) : c.json({ error: "no run on that day" }, 404);
});
