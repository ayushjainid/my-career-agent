// Beta loop B5: offer timing from the person's own stage history, and pay benchmarks from LCA
// filings attached to jobs.

import { estimateOffers, learnStageDays, offerWindow, timeToOfferDays, titleFamily, type TimingApp } from "@my-career-agent/core";
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { stmt, type Row, type TenantDb } from "./lib/tenant.js";

export const timing = new Hono<AppBindings>();

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

/** Every application with the date it first reached each stage, from the append-only log. */
export async function loadTimingApps(db: TenantDb, uid: string): Promise<TimingApp[]> {
  const [apps = [], events = []] = await db.asUser(uid, [
    stmt(`SELECT a.id, a.state, a.submitted_at, j.company_id, co.name AS company, p.tier
          FROM mca.application a JOIN mca.job j ON j.id = a.job_id JOIN mca.company co ON co.id = j.company_id
          LEFT JOIN mca.company_preference p ON p.company_id = j.company_id
          WHERE a.state NOT IN ('queued','approved','ready_for_review','skipped','failed')`),
    stmt(`SELECT application_id, payload->>'to' AS to_state, min(created_at) AS at FROM mca.application_event
          WHERE kind = 'state_change' AND payload->>'to' IN ('screen','interview','offer') GROUP BY 1, 2`),
  ]);
  return apps.map((a) => {
    const reached: TimingApp["reached"] = {};
    for (const e of events.filter((x) => x.application_id === a.id)) reached[e.to_state as "screen"] = iso(e.at)!;
    return { id: String(a.id), companyId: String(a.company_id), company: String(a.company), tier: (a.tier as TimingApp["tier"]) ?? null,
      state: String(a.state), submittedAt: iso(a.submitted_at), reached };
  });
}

/** The offer window: expected offer per live process, how stage durations were learned, and holds. */
timing.get("/timing", async (c) => {
  const uid = c.get("userId");
  const db = c.get("db");
  const apps = await loadTimingApps(db, uid);
  const learned = learnStageDays(apps);
  const estimates = estimateOffers(apps, learned, new Date());
  const [[u] = [], runs = []] = await db.asUser(uid, [
    stmt(`SELECT offer_window_start::text AS offer_window_start FROM mca.app_user`),
    stmt(`SELECT held_back FROM mca.queue_run ORDER BY run_date DESC LIMIT 1`),
  ]);
  const held = ((runs[0]?.held_back as Array<{ jobId: string; companyId: string; releaseOn: string }> | undefined) ?? []);
  const [names = []] = held.length
    ? await db.asUser(uid, [stmt(`SELECT j.id, co.name FROM mca.job j JOIN mca.company co ON co.id = j.company_id WHERE j.id = ANY ($1::uuid[])`, held.map((x) => x.jobId))])
    : [[]];
  return c.json({
    stageDays: learned.days,
    basis: learned.basis,
    samples: learned.samples,
    timeToOfferDays: timeToOfferDays(learned.days),
    estimates,
    window: offerWindow(estimates, (u?.offer_window_start as string | null) ?? null),
    heldBack: held.map((x) => ({ ...x, company: names.find((n) => n.id === x.jobId)?.name ?? null })),
  });
});

export interface PayBenchmark { scope: "company" | "market"; n: number; p25: number; p50: number; p75: number; currency: string; periodEnd: string | null }

/** Benchmarks for (company, title) pairs: the company's own filings first, else the market. */
export async function payBenchmarks(db: TenantDb, uid: string, rows: Array<{ companyId: string; title: string; country?: string | null }>): Promise<Map<string, PayBenchmark>> {
  const out = new Map<string, PayBenchmark>();
  const fams = [...new Set(rows.map((r) => titleFamily(r.title)).filter(Boolean))];
  if (!fams.length) return out;
  const [bench = []] = await db.asUser(uid, [
    stmt(`SELECT company_id, employer_norm, title_family, n, p25, p50, p75, currency, period_end::text AS period_end
          FROM mca.pay_benchmark WHERE country = 'US' AND title_family = ANY ($1::text[])
            AND (employer_norm = '*' OR company_id = ANY ($2::uuid[]))
          ORDER BY period_end DESC NULLS LAST`, fams, [...new Set(rows.map((r) => r.companyId))]),
  ]);
  const pick = (b: Row, scope: PayBenchmark["scope"]): PayBenchmark => ({
    scope, n: Number(b.n), p25: Number(b.p25), p50: Number(b.p50), p75: Number(b.p75), currency: String(b.currency), periodEnd: (b.period_end as string | null) ?? null });
  for (const r of rows) {
    if ((r.country ?? "US").toUpperCase() !== "US") continue;
    const fam = titleFamily(r.title);
    const own = bench.find((b) => b.company_id === r.companyId && b.title_family === fam);
    const market = bench.find((b) => b.employer_norm === "*" && b.title_family === fam);
    if (own) out.set(`${r.companyId}|${r.title}`, pick(own, "company"));
    else if (market) out.set(`${r.companyId}|${r.title}`, pick(market, "market"));
  }
  return out;
}
