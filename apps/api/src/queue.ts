// POC loop P3 wiring: load one user's inputs, run the pure builder from core, save the result.
// Every query runs as that user under row-level security; catalog tables are read-only to mca_app.

import {
  buildDailyQueue,
  learnStageDays,
  timeToOfferDays,
  extractRequirements,
  type CompanyPreference,
  type DeclaredLanguage,
  type Fact,
  type JobRequirements,
  type LanguageLevel,
  type QueueInput,
  type QueueJob,
  type QueueResult,
  type Seniority,
  type WorkAuthStatus,
} from "@my-career-agent/core";
import { stmt, type Row, type TenantDb } from "./lib/tenant.js";
import type { Env } from "./env.js";
import { dailyLimit } from "./billing.js";
import { loadTimingApps } from "./timingApi.js";

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const SENIORITY_ORDER: Seniority[] = ["entry", "mid", "senior", "lead", "executive"];

/** How many open jobs one run considers. Enough for 100 companies; raise with the catalog. */
export const MAX_JOBS_PER_RUN = 3000;

export async function loadQueueInput(db: TenantDb, userId: string, today: Date): Promise<QueueInput | null> {
  const [users, facts, langs, auth, targets, prefs, contacts, apps, jobs] = await db.asUser(userId, [
    stmt(`SELECT daily_target, max_active_processes, offer_window_start::text AS offer_window_start FROM mca.app_user`),
    stmt(`SELECT id, kind, text, skills, start_date::text AS start_date, end_date::text AS end_date, verified FROM mca.fact`),
    stmt(`SELECT language, level FROM mca.user_language`),
    stmt(`SELECT country, status, min_lca_filings, min_perm_certified FROM mca.work_auth`),
    stmt(`SELECT country, seniority, pay_floor, pay_currency FROM mca.target`),
    stmt(`SELECT company_id, tier, block_mode, block_reason, block_expires_at::text AS block_expires_at, include_subsidiaries FROM mca.company_preference`),
    stmt(`SELECT company_id, messages_count, last_message_at::text AS last_message_at, connected_on::text AS connected_on,
                 last_ask_at::text AS last_ask_at
          FROM mca.contact WHERE company_id IS NOT NULL`),
    stmt(`SELECT a.job_id, a.state, a.created_at, a.planned_date::text AS planned_date, j.company_id FROM mca.application a JOIN mca.job j ON j.id = a.job_id`),
    stmt(
      `SELECT j.id, j.company_id, j.title, j.country,
              CASE WHEN j.requirements ? 'signals' THEN NULL ELSE j.description_text END AS description_text, j.requirements, j.sponsorship_text_signal, j.posted_at, j.status,
              j.pay_max, j.pay_currency, j.integrity->>'level' AS integrity_level,
              s.filings, s.perm_certified, s.perm_denied, s.last_filing, s.rating
       FROM mca.job j
       LEFT JOIN LATERAL (
         SELECT sum(filings) FILTER (WHERE source IN ('dol_lca', 'esdc_lmia', 'dete_permits')
                                       OR (source = 'ukvi_register' AND coalesce(extra->>'route', '') ILIKE 'skilled worker%')) AS filings,
                sum(certified) FILTER (WHERE source = 'dol_perm') AS perm_certified,
                sum(denied) FILTER (WHERE source = 'dol_perm') AS perm_denied,
                max(period_end)::text AS last_filing,
                min(extra->>'rating') FILTER (WHERE source = 'ukvi_register') AS rating
         FROM mca.sponsor_record r
         WHERE r.company_id = j.company_id AND r.country = coalesce(j.country, 'US')
       ) s ON true
       WHERE j.status = 'open' AND j.last_seen_at > now() - interval '30 days'
       ORDER BY j.posted_at DESC NULLS LAST
       LIMIT $1`,
      MAX_JOBS_PER_RUN,
    ),
  ]) as Row[][];

  const user = users?.[0];
  if (!user || !targets?.length) return null; // no profile or no target: nothing to plan

  const profileFacts: Fact[] = (facts ?? []).map((r) => ({
    id: String(r.id),
    kind: r.kind as Fact["kind"],
    text: String(r.text),
    skills: (r.skills as string[]) ?? [],
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    verified: Boolean(r.verified),
  }));
  const seniority =
    (targets ?? [])
      .map((t) => t.seniority as Seniority | null)
      .filter((s): s is Seniority => !!s)
      .sort((a, b) => SENIORITY_ORDER.indexOf(b) - SENIORITY_ORDER.indexOf(a))[0] ?? "mid";
  const floorRow = (targets ?? []).find((t) => t.pay_floor !== null && t.pay_currency);

  const workAuth: QueueInput["workAuth"] = {};
  for (const a of auth ?? [])
    workAuth[String(a.country).toUpperCase()] = {
      status: a.status as WorkAuthStatus,
      thresholds: { minFilings: Number(a.min_lca_filings), minPermCertified: Number(a.min_perm_certified) },
    };

  const prefMap = new Map<string, CompanyPreference>();
  for (const p of prefs ?? [])
    prefMap.set(String(p.company_id), {
      companyId: String(p.company_id),
      tier: (p.tier as CompanyPreference["tier"]) ?? null,
      blockMode: (p.block_mode as CompanyPreference["blockMode"]) ?? null,
      blockReason: (p.block_reason as string | null) ?? null,
      blockExpiresAt: (p.block_expires_at as string | null) ?? null,
      includeSubsidiaries: Boolean(p.include_subsidiaries),
    });

  const alreadyApplied = new Set<string>();
  const recent = new Map<string, number>();
  let active = 0;
  let backlog = 0; // queued on an earlier day and not yet acted on
  const todayIso = isoDay(today);
  const sixtyDaysAgo = today.getTime() - 60 * 86_400_000;
  for (const a of apps ?? []) {
    alreadyApplied.add(String(a.job_id));
    const state = String(a.state);
    if (["screen", "interview"].includes(state)) active++;
    if (["queued", "approved", "ready_for_review"].includes(state) && a.planned_date && String(a.planned_date) < todayIso) backlog++;
    const created = Date.parse(iso(a.created_at) ?? "");
    if (!["skipped", "failed"].includes(state) && created >= sixtyDaysAgo) {
      const k = String(a.company_id);
      recent.set(k, (recent.get(k) ?? 0) + 1);
    }
  }

  const queueJobs: QueueJob[] = (jobs ?? []).map((j) => {
    const stored = j.requirements as Partial<JobRequirements> | null;
    const requirements: JobRequirements =
      stored && Array.isArray(stored.mustHave)
        ? {
            mustHave: stored.mustHave,
            niceToHave: stored.niceToHave ?? [],
            minYears: stored.minYears ?? null,
            seniority: stored.seniority ?? null,
            sponsorshipSignal: stored.sponsorshipSignal ?? (j.sponsorship_text_signal as JobRequirements["sponsorshipSignal"] | null) ?? "none",
          }
        : extractRequirements(String(j.title), String(j.description_text ?? ""));
    const hasSponsor = j.filings !== null || j.perm_certified !== null;
    return {
      jobId: String(j.id),
      companyId: String(j.company_id),
      title: String(j.title),
      country: (j.country as string | null) ?? "US",
      descriptionText: String(j.description_text ?? ""),
      signals: stored?.signals ?? null,
      requirements,
      postedAt: iso(j.posted_at),
      status: j.status as QueueJob["status"],
      payMax: num(j.pay_max),
      payCurrency: (j.pay_currency as string | null) ?? null,
      integrityLevel: (j.integrity_level as QueueJob["integrityLevel"]) ?? null,
      sponsor: hasSponsor
        ? {
            filings: num(j.filings) ?? 0,
            permCertified: num(j.perm_certified) ?? 0,
            permDenied: num(j.perm_denied) ?? 0,
            lastFilingDate: (j.last_filing as string | null) ?? null,
            rating: (j.rating as string | null) ?? null,
          }
        : null,
    };
  });

  return {
    jobs: queueJobs,
    profile: { facts: profileFacts, seniority },
    languages: (langs ?? []).map((l) => ({ language: String(l.language), level: l.level as LanguageLevel })) as DeclaredLanguage[],
    workAuth,
    prefs: prefMap,
    recentApplicationsByCompany: recent,
    alreadyApplied,
    payFloor: floorRow ? { amount: Number(floorRow.pay_floor), currency: String(floorRow.pay_currency) } : null,
    contacts: (contacts ?? []).map((c) => ({
      companyId: String(c.company_id),
      messagesCount: Number(c.messages_count ?? 0),
      lastMessageAt: (c.last_message_at as string | null) ?? null,
      connectedOn: (c.connected_on as string | null) ?? null,
      lastAskAt: (c.last_ask_at as string | null) ?? null,
    })),
    targetCountries: [...new Set((targets ?? []).map((t) => String(t.country).toUpperCase()))],
    today,
    // Unreviewed items from earlier days count against today's target, so the queue never piles up.
    dailyTarget: Math.max(0, Number(user.daily_target) - backlog),
    activeProcesses: active,
    maxActiveProcesses: Number(user.max_active_processes),
    offerWindowStart: user.offer_window_start ? new Date(String(user.offer_window_start)) : null,
  };
}

/** Writes today's queue. Idempotent per day: re-running never duplicates an application. */
export async function saveQueue(db: TenantDb, userId: string, today: Date, r: QueueResult): Promise<void> {
  const day = isoDay(today);
  const rows = r.queue.map((q) => ({
    job_id: q.jobId,
    fit_score: q.fitScore,
    rank_score: q.rankScore,
    gates: q.gates,
    gate_verdict: q.gates.some((g) => g.verdict === "FLAG") ? "FLAG" : "PASS",
    notes: q.flags.length ? q.flags.join("\n") : null,
  }));
  await db.asUser(userId, [
    stmt(
      `INSERT INTO mca.application (user_id, job_id, state, planned_date, fit_score, rank_score, gates, gate_verdict, notes)
       SELECT $1, x.job_id, 'queued', $2::date, x.fit_score, x.rank_score, x.gates, x.gate_verdict, x.notes
       FROM jsonb_to_recordset($3::jsonb) AS x(job_id uuid, fit_score integer, rank_score numeric, gates jsonb, gate_verdict text, notes text)
       ON CONFLICT (user_id, job_id) DO NOTHING`,
      userId,
      day,
      JSON.stringify(rows),
    ),
    stmt(
      `INSERT INTO mca.queue_run (user_id, run_date, builder, queued, held_back, excluded, note)
       VALUES ($1, $2::date, $3, $4, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (user_id, run_date) DO UPDATE SET builder = EXCLUDED.builder, queued = EXCLUDED.queued,
         held_back = EXCLUDED.held_back, excluded = EXCLUDED.excluded, note = EXCLUDED.note, created_at = now()`,
      userId,
      day,
      r.builderVersion,
      r.queue.length,
      JSON.stringify(r.heldBack),
      JSON.stringify(r.excluded.slice(0, 500)),
      r.note,
    ),
  ]);
}

export async function runQueueForUser(db: TenantDb, userId: string, today: Date, limit: number | null = null): Promise<QueueResult | null> {
  const input = await loadQueueInput(db, userId, today);
  if (!input) return null;
  if (limit !== null) input.dailyTarget = Math.min(input.dailyTarget, limit);
  // Dream companies are held back by the person's own time-to-offer once there is history for it.
  const learned = learnStageDays(await loadTimingApps(db, userId));
  const tto = timeToOfferDays(learned.days);
  input.timeToOfferDays = () => tto;
  const result = buildDailyQueue(input);
  // An empty catalog otherwise reads as "queued 0, left out 0" with no reason given.
  if (!input.jobs.length && !result.note)
    result.note = "There are no open jobs to choose from yet. Jobs come from the job boards of the companies in jobs/companies.csv; add companies there to widen the search.";
  await saveQueue(db, userId, today, result);
  return result;
}

/** Builds today's queue for everyone with a target role (the daily GitHub job). */
export async function runAllQueues(env: Env, db: TenantDb, users: string[]): Promise<Array<{ user: string; queued: number; excluded: number; error?: string }>> {
  const today = new Date();
  const out = [];
  for (const user of users) {
    try {
      const r = await runQueueForUser(db, user, today, await dailyLimit(env, db, user));
      out.push({ user, queued: r?.queue.length ?? 0, excluded: r?.excluded.length ?? 0 });
    } catch (err) {
      out.push({ user, queued: 0, excluded: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
