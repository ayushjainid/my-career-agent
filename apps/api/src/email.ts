// Inbound email: users forward LinkedIn job alerts and ATS confirmation emails to a personal
// address (<local>@INBOUND_DOMAIN). Confirmations mark applications submitted with no tool integration.

import { normalizeCompanyName } from "@life-vector/core";
import type { Env } from "./env.js";
import { appDb, withUser } from "./lib/db.js";

export type EmailClass = "application_confirmation" | "job_alert" | "rejection" | "interview_invite" | "other";

const CONFIRM = [
  /thank(?:s| you) for (?:applying|your application|your interest in)/i,
  /(?:application|your application) (?:has been |was )?(?:received|submitted)/i,
  /we(?:'|’)ve received your application/i,
];
const REJECT = [
  /(?:not|won(?:'|’)t) be (?:moving|proceeding) forward/i,
  /decided to (?:move forward|proceed) with other candidates/i,
  /unfortunately/i,
];
const INVITE = [/\b(?:interview|phone screen|schedule (?:a|some) time|next steps)\b/i];

export function classifyEmail(from: string, subject: string, bodySample = ""): EmailClass {
  const text = `${subject}\n${bodySample}`;
  if (/linkedin\.com/i.test(from) && /\bjobs?\b/i.test(subject)) return "job_alert";
  if (CONFIRM.some((r) => r.test(text))) return "application_confirmation";
  if (REJECT.some((r) => r.test(text)) && /application|position|role|candidacy/i.test(text)) return "rejection";
  if (INVITE.some((r) => r.test(subject))) return "interview_invite";
  return "other";
}

/** Pulls a likely company name from confirmation subjects such as "Thank you for applying to Acme". */
export function companyFromSubject(subject: string): string | null {
  const m = /(?:applying|application|interest)\s+(?:to|at|with|for)\s+(?:the\s+)?(.+?)(?:\s*[-–|:!.]|\s+for\s+|$)/i.exec(subject);
  const name = m?.[1]?.trim();
  return name && name.length >= 2 && name.length <= 80 ? name : null;
}

async function readSample(raw: ReadableStream<Uint8Array>, limit = 20_000): Promise<string> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, Math.max(0, size - off)), off);
    off += c.byteLength;
  }
  // Skip headers; we only want a short body sample for classification.
  const text = new TextDecoder().decode(buf);
  const split = text.indexOf("\r\n\r\n");
  return (split >= 0 ? text.slice(split + 4) : text).slice(0, 4_000);
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const local = message.to.split("@")[0]?.toLowerCase() ?? "";
  const sql = appDb(env.DATABASE_URL);
  const route = (await sql`SELECT user_id FROM lv.inbound_route WHERE local_part = ${local}`) as Array<{ user_id: string }>;
  const userId = route[0]?.user_id;
  if (!userId) {
    message.setReject("Unknown recipient");
    return;
  }

  const subject = message.headers.get("subject") ?? "";
  const from = message.headers.get("from") ?? message.from;
  const body = await readSample(message.raw);
  const kind = classifyEmail(from, subject, body);
  const company = companyFromSubject(subject);
  const companyNorm = company ? normalizeCompanyName(company) : null;

  await withUser(sql, userId, (q) => {
    const queries = [
      q`INSERT INTO lv.inbound_email (user_id, from_address, subject, classification)
        VALUES (${userId}, ${from}, ${subject.slice(0, 500)}, ${kind})`,
    ];
    if (kind === "application_confirmation" && companyNorm) {
      // Mark the most recent approved / ready application at that company as submitted.
      queries.push(q`
        WITH target AS (
          SELECT a.id FROM lv.application a
          JOIN lv.job j ON j.id = a.job_id
          JOIN lv.company c ON c.id = j.company_id
          WHERE a.state IN ('approved','ready_for_review')
            AND (c.name_norm = ${companyNorm} OR ${companyNorm} = ANY (c.aliases))
          ORDER BY a.created_at DESC LIMIT 1
        ), upd AS (
          UPDATE lv.application SET state = 'submitted', submitted_at = now()
          WHERE id IN (SELECT id FROM target) RETURNING id
        )
        INSERT INTO lv.application_event (user_id, application_id, kind, payload)
        SELECT ${userId}, id, 'email_detected', jsonb_build_object('subject', ${subject.slice(0, 200)}::text)
        FROM upd`);
    }
    return queries;
  });
}
