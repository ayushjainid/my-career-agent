// Scheduled ingestion: fetch a batch of company boards, diff against the catalog, write changes.
// Runs as the mca_ingest role (catalog only; no tenant data).

import { compactIntegrity, extractRequirements, postingSignals, type AtsVendor, type NormalizedJob, inferCountry } from "@my-career-agent/core";
import { diffBoard, type StoredJobKey } from "./ats/diff.js";
import { fetchAny, NEEDS_KNOWN, SUPPORTED_VENDORS } from "./ats/adapters.js";
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
    country: inferCountry(job.locationText),
    remote_type: job.remoteType,
    pay_min: job.pay?.min ?? null,
    pay_max: job.pay?.max ?? null,
    pay_currency: job.pay?.currency ?? null,
    pay_period: job.pay?.period ?? "unknown",
    pay_source: job.pay?.source ?? null,
    posted_at: job.postedAt,
    apply_url: job.applyUrl,
    description_text: job.descriptionText.slice(0, 50_000),
    requirements: { mustHave: req.mustHave, niceToHave: req.niceToHave, minYears: req.minYears, seniority: req.seniority, sponsorshipSignal: req.sponsorshipSignal, postingLanguage: req.postingLanguage,
      // Read once here so ranking never has to load or scan the posting text.
      signals: postingSignals(job.descriptionText), extractor: "det-2" },
    sponsorship_text_signal: req.sponsorshipSignal,
    integrity: job.integrity ? compactIntegrity(job.integrity) : null,
  };
}

function upsertJobs(sql: Sql, companyId: string, rows: ReturnType<typeof toRecord>[]) {
  return sql`
      INSERT INTO mca.job (company_id, ats_vendor, ats_job_id, title, location_text, country, remote_type,
        pay_min, pay_max, pay_currency, pay_period, pay_source, posted_at, apply_url,
        description_text, requirements, sponsorship_text_signal, integrity, status, last_seen_at)
      SELECT ${companyId}::uuid, r.ats_vendor, r.ats_job_id, r.title, r.location_text, r.country, r.remote_type,
        r.pay_min, r.pay_max, r.pay_currency, r.pay_period, r.pay_source, r.posted_at, r.apply_url,
        r.description_text, r.requirements, r.sponsorship_text_signal, r.integrity, 'open', now()
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
        ats_vendor text, ats_job_id text, title text, location_text text, country text, remote_type text,
        pay_min numeric, pay_max numeric, pay_currency text, pay_period text, pay_source text,
        posted_at timestamptz, apply_url text, description_text text, requirements jsonb,
        sponsorship_text_signal text, integrity jsonb)
      ON CONFLICT (ats_vendor, company_id, ats_job_id) DO UPDATE SET
        title = EXCLUDED.title, location_text = EXCLUDED.location_text, country = EXCLUDED.country, remote_type = EXCLUDED.remote_type,
        pay_min = EXCLUDED.pay_min, pay_max = EXCLUDED.pay_max, pay_currency = EXCLUDED.pay_currency,
        pay_period = EXCLUDED.pay_period, pay_source = EXCLUDED.pay_source, apply_url = EXCLUDED.apply_url,
        description_text = EXCLUDED.description_text, requirements = EXCLUDED.requirements,
        sponsorship_text_signal = EXCLUDED.sponsorship_text_signal, integrity = EXCLUDED.integrity,
        status = CASE WHEN mca.job.status = 'stale' THEN 'stale' ELSE 'open' END,
        last_seen_at = now()`;
}

async function ingestCompany(sql: Sql, c: CompanyRow, report: IngestReport): Promise<void> {
  const stored = (await sql`
    SELECT ats_job_id AS "atsJobId", status, first_seen_at AS "firstSeenAt"
    FROM mca.job WHERE company_id = ${c.id}`) as StoredJobKey[];
  // Paged systems skip detail requests for jobs already stored and still open.
  const known = NEEDS_KNOWN.has(c.ats_vendor) ? new Set(stored.filter((s) => s.status !== "closed").map((s) => s.atsJobId)) : undefined;
  const got = await fetchAny({ vendor: c.ats_vendor, board: c.ats_board, region: c.ats_region }, { known });
  const diff = diffBoard(got.jobs, stored.map((s) => ({ ...s, firstSeenAt: new Date(s.firstSeenAt).toISOString() })));
  // Still listed (just not re-read) is not closed; an incomplete listing closes nothing.
  const listed = new Set(got.touch);
  diff.closedIds = got.complete ? diff.closedIds.filter((id) => !listed.has(id)) : [];

  const upserts = [...diff.added, ...diff.stillOpen, ...diff.reopened].map(toRecord);
  // Large boards (Notion's is ~3 MB) go in chunks: one database request has a size limit. Upserts
  // are idempotent, so a failure part-way is repaired by the next run.
  const CHUNK = 150;
  for (let i = 0; i + CHUNK < upserts.length; i += CHUNK) await sql.transaction([upsertJobs(sql, c.id, upserts.slice(i, i + CHUNK))]);
  const last = upserts.slice(Math.floor(Math.max(0, upserts.length - 1) / CHUNK) * CHUNK);
  const queries = [];
  if (last.length) queries.push(upsertJobs(sql, c.id, last));
  if (diff.closedIds.length)
    queries.push(sql`UPDATE mca.job SET status = 'closed' WHERE company_id = ${c.id} AND ats_job_id = ANY(${diff.closedIds}::text[])`);
  if (got.touch.length)
    queries.push(sql`UPDATE mca.job SET last_seen_at = now(), status = CASE WHEN status = 'stale' THEN 'stale' ELSE 'open' END
                     WHERE company_id = ${c.id} AND ats_job_id = ANY(${got.touch}::text[])`);
  if (diff.staleIds.length)
    queries.push(sql`UPDATE mca.job SET status = 'stale' WHERE company_id = ${c.id} AND ats_job_id = ANY(${diff.staleIds}::text[])`);
  queries.push(sql`UPDATE mca.company SET last_fetched_at = now() WHERE id = ${c.id}`);
  await sql.transaction(queries);

  report.added += diff.added.length + diff.reopened.length;
  report.updated += diff.stillOpen.length + got.touch.length;
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

export interface IngestOptions {
  /** Boards to fetch this run (default INGEST_BOARDS_PER_RUN). */
  limit?: number;
  /** Only boards not fetched for this many minutes (default 0: the oldest boards, whatever their age). */
  staleAfterMinutes?: number;
}

/**
 * Fetches the boards that were fetched longest ago. Boards are claimed in one statement
 * (SKIP LOCKED), so the cron and on-demand refreshes running at once never fetch the same board,
 * and a board whose run dies part-way is not retried until it is stale again.
 */
export async function runIngest(env: Env, opts: IngestOptions = {}): Promise<IngestReport & { remaining: number; total: number }> {
  const sql = env.TEST_INGEST_SQL ?? appDb(env.INGEST_DATABASE_URL);
  const batch = Math.max(1, opts.limit ?? (Number(env.INGEST_BOARDS_PER_RUN) || 40));
  const minutes = Math.max(0, opts.staleAfterMinutes ?? 0);
  const companies = (await sql`
    UPDATE mca.company SET last_fetched_at = now()
    WHERE id IN (
      SELECT id FROM mca.company
      WHERE ats_vendor = ANY(${[...SUPPORTED_VENDORS]}::text[]) AND ats_board IS NOT NULL
        AND (last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(mins => ${minutes}))
      ORDER BY last_fetched_at NULLS FIRST
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, ats_vendor, ats_board, ats_region`) as CompanyRow[];

  const report: IngestReport = { boards: companies.length, added: 0, updated: 0, closed: 0, stale: 0, errors: [] };
  await mapLimit(companies, 6, async (c) => {
    try {
      await ingestCompany(sql, c, report);
    } catch (err) {
      report.errors.push({ board: `${c.ats_vendor}:${c.ats_board}`, error: err instanceof Error ? err.message : String(err) });
    }
  });
  console.log(JSON.stringify({ event: "ingest", ...report }));
  const [counts] = (await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(mins => ${Math.max(minutes, 1)}))::int AS remaining
    FROM mca.company WHERE ats_vendor = ANY(${[...SUPPORTED_VENDORS]}::text[]) AND ats_board IS NOT NULL`) as Array<{ total: number; remaining: number }>;
  return { ...report, total: counts?.total ?? 0, remaining: counts?.remaining ?? 0 };
}
