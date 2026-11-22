// Scheduled ingestion: fetch a batch of company boards, diff against the catalog, write changes.
// Runs as the lv_ingest role (catalog only; no tenant data).

import { compactIntegrity, extractRequirements, type AtsVendor, type NormalizedJob } from "@life-vector/core";
import { diffBoard, type StoredJobKey } from "./ats/diff.js";
import { fetchBoard } from "./ats/adapters.js";
import type { Env } from "./env.js";
import { appDb, type Sql } from "./lib/db.js";

interface CompanyRow {
  id: string;
  ats_vendor: AtsVendor;
  ats_board: string;
  ats_region: string | null;
}

export interface IngestReport {
  boards: number;
  added: number;
  updated: number;
  closed: number;
  stale: number;
  errors: Array<{ board: string; error: string }>;
}

export function toRecord(job: NormalizedJob) {
  const req = extractRequirements(job.title, job.descriptionText);
  return {
    ats_vendor: job.atsVendor,
    ats_job_id: job.atsJobId,
    title: job.title.slice(0, 300),
    location_text: job.locationText,
    remote_type: job.remoteType,
    pay_min: job.pay?.min ?? null,
    pay_max: job.pay?.max ?? null,
    pay_currency: job.pay?.currency ?? null,
    pay_period: job.pay?.period ?? "unknown",
    pay_source: job.pay?.source ?? null,
    posted_at: job.postedAt,
    apply_url: job.applyUrl,
    description_text: job.descriptionText.slice(0, 50_000),
    requirements: { mustHave: req.mustHave, niceToHave: req.niceToHave, minYears: req.minYears, seniority: req.seniority, extractor: "det-1" },
    sponsorship_text_signal: req.sponsorshipSignal,
    integrity: job.integrity ? compactIntegrity(job.integrity) : null,
  };
}

async function ingestCompany(sql: Sql, c: CompanyRow, report: IngestReport): Promise<void> {
  const fresh = await fetchBoard({ vendor: c.ats_vendor, board: c.ats_board, region: c.ats_region });
  const stored = (await sql`
    SELECT ats_job_id AS "atsJobId", status, first_seen_at AS "firstSeenAt"
    FROM lv.job WHERE company_id = ${c.id}`) as StoredJobKey[];
  const diff = diffBoard(fresh, stored.map((s) => ({ ...s, firstSeenAt: new Date(s.firstSeenAt).toISOString() })));

  const upserts = [...diff.added, ...diff.stillOpen, ...diff.reopened].map(toRecord);
  const queries = [];
  if (upserts.length) {
    queries.push(sql`
      INSERT INTO lv.job (company_id, ats_vendor, ats_job_id, title, location_text, remote_type,
        pay_min, pay_max, pay_currency, pay_period, pay_source, posted_at, apply_url,
        description_text, requirements, sponsorship_text_signal, integrity, status, last_seen_at)
      SELECT ${c.id}::uuid, r.ats_vendor, r.ats_job_id, r.title, r.location_text, r.remote_type,
        r.pay_min, r.pay_max, r.pay_currency, r.pay_period, r.pay_source, r.posted_at, r.apply_url,
        r.description_text, r.requirements, r.sponsorship_text_signal, r.integrity, 'open', now()
      FROM jsonb_to_recordset(${JSON.stringify(upserts)}::jsonb) AS r(
        ats_vendor text, ats_job_id text, title text, location_text text, remote_type text,
        pay_min numeric, pay_max numeric, pay_currency text, pay_period text, pay_source text,
        posted_at timestamptz, apply_url text, description_text text, requirements jsonb,
        sponsorship_text_signal text, integrity jsonb)
      ON CONFLICT (ats_vendor, company_id, ats_job_id) DO UPDATE SET
        title = EXCLUDED.title, location_text = EXCLUDED.location_text, remote_type = EXCLUDED.remote_type,
        pay_min = EXCLUDED.pay_min, pay_max = EXCLUDED.pay_max, pay_currency = EXCLUDED.pay_currency,
        pay_period = EXCLUDED.pay_period, pay_source = EXCLUDED.pay_source, apply_url = EXCLUDED.apply_url,
        description_text = EXCLUDED.description_text, requirements = EXCLUDED.requirements,
        sponsorship_text_signal = EXCLUDED.sponsorship_text_signal, integrity = EXCLUDED.integrity,
        status = CASE WHEN lv.job.status = 'stale' THEN 'stale' ELSE 'open' END,
        last_seen_at = now()`);
  }
  if (diff.closedIds.length)
    queries.push(sql`UPDATE lv.job SET status = 'closed' WHERE company_id = ${c.id} AND ats_job_id = ANY(${diff.closedIds}::text[])`);
  if (diff.staleIds.length)
    queries.push(sql`UPDATE lv.job SET status = 'stale' WHERE company_id = ${c.id} AND ats_job_id = ANY(${diff.staleIds}::text[])`);
  queries.push(sql`UPDATE lv.company SET last_fetched_at = now() WHERE id = ${c.id}`);
  await sql.transaction(queries);

  report.added += diff.added.length + diff.reopened.length;
  report.updated += diff.stillOpen.length;
  report.closed += diff.closedIds.length;
  report.stale += diff.staleIds.length;
}

/** Simple concurrency limiter so one run never opens too many sockets at once. */
async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runIngest(env: Env): Promise<IngestReport> {
  const sql = appDb(env.INGEST_DATABASE_URL);
  const batch = Math.max(1, Number(env.INGEST_BOARDS_PER_RUN) || 40);
  const companies = (await sql`
    SELECT id, ats_vendor, ats_board, ats_region FROM lv.company
    WHERE ats_vendor IN ('greenhouse','lever','ashby') AND ats_board IS NOT NULL
    ORDER BY last_fetched_at NULLS FIRST
    LIMIT ${batch}`) as CompanyRow[];

  const report: IngestReport = { boards: companies.length, added: 0, updated: 0, closed: 0, stale: 0, errors: [] };
  await mapLimit(companies, 6, async (c) => {
    try {
      await ingestCompany(sql, c, report);
    } catch (err) {
      report.errors.push({ board: `${c.ats_vendor}:${c.ats_board}`, error: err instanceof Error ? err.message : String(err) });
    }
  });
  console.log(JSON.stringify({ event: "ingest", ...report }));
  return report;
}
