// Beta loop B3: inbound email. Users forward confirmation, rejection and interview emails (or set
// a mail filter) to a personal address, <local>@INBOUND_DOMAIN. Each message is classified, matched
// to an application at that company, and moves it one step through the state machine. Nothing is
// sent, and only the subject, sender and classification are stored, never the body.

import { normalizeCompanyName } from "@my-career-agent/core";
import type { Env } from "./env.js";
import { appDb } from "./lib/db.js";
import { neonTenantDb, stmt, type TenantDb } from "./lib/tenant.js";

export type EmailClass = "application_confirmation" | "job_alert" | "rejection" | "interview_invite" | "other";

const CONFIRM = [
  /thank(?:s| you) for (?:applying|your application|your interest in)/i,
  /(?:application|your application) (?:has been |was )?(?:received|submitted)/i,
  /we(?:'|’)ve received your application/i,
];
const REJECT = [
  /(?:not|won(?:'|’)t) be (?:moving|proceeding) forward/i,
  /decided to (?:move forward|proceed) with other candidates/i,
  /(?:position|role) has been filled/i,
  /unfortunately/i,
];
const INVITE = [/\b(?:interview|phone screen|schedule (?:a|some) time|next steps|availability)\b/i];

export function classifyEmail(from: string, subject: string, bodySample = ""): EmailClass {
  const text = `${subject}\n${bodySample}`;
  if (/linkedin\.com/i.test(from) && /\bjobs?\b/i.test(subject)) return "job_alert";
  if (REJECT.some((r) => r.test(text)) && /application|position|role|candidacy/i.test(text)) return "rejection";
  if (CONFIRM.some((r) => r.test(text))) return "application_confirmation";
  if (INVITE.some((r) => r.test(subject))) return "interview_invite";
  return "other";
}

/** A likely company name from subjects such as "Thank you for applying to Acme". */
export function companyFromSubject(subject: string): string | null {
  const m = /(?:applying|application|interest|update|interview)\s+(?:to|at|with|for|from)\s+(?:the\s+)?(.+?)(?:\s*[-–|:!.]|\s+for\s+|$)/i.exec(subject);
  const name = m?.[1]?.trim();
  return name && name.length >= 2 && name.length <= 80 ? name : null;
}

/** The sender's organisation from the From header: "Acme Recruiting <no-reply@acme.com>". */
export function companyFromSender(from: string): string | null {
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.replace(/\b(recruiting|careers|talent( acquisition)?|hiring|jobs|team|hr|no-?reply)\b/gi, "").trim();
  if (display && display.length >= 2 && !/@/.test(display)) return display;
  const domain = /@([a-z0-9.-]+)>?\s*$/i.exec(from)?.[1]?.toLowerCase();
  const ats = /(greenhouse|lever|ashbyhq|myworkday|smartrecruiters|workable|icims|jobvite)\./;
  if (!domain || ats.test(domain)) return null;
  const parts = domain.split(".");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}

/** State each email kind moves an application to, and from which states. */
const MOVES: Partial<Record<EmailClass, { to: string; from: string[] }>> = {
  application_confirmation: { to: "submitted", from: ["approved", "ready_for_review"] },
  rejection: { to: "rejected", from: ["submitted", "screen", "interview"] },
  interview_invite: { to: "screen", from: ["submitted"] },
};

export interface InboundMessage { to: string; from: string; subject: string; body: string }
export type InboundResult = { accepted: false } | { accepted: true; kind: EmailClass; action: string | null; applicationId: string | null };

export async function processInbound(db: TenantDb, m: InboundMessage): Promise<InboundResult> {
  const local = (m.to.split("@")[0] ?? "").toLowerCase();
  if (!/^[a-z0-9]{6,32}$/.test(local)) return { accepted: false };
  const [[route] = []] = await db.asSystem([stmt(`SELECT user_id FROM mca.inbound_route WHERE local_part = $1`, local)]);
  const userId = route?.user_id as string | undefined;
  if (!userId) return { accepted: false };

  const kind = classifyEmail(m.from, m.subject, m.body);
  const names = [companyFromSubject(m.subject), companyFromSender(m.from)].filter((x): x is string => !!x).map(normalizeCompanyName).filter(Boolean);
  const move = MOVES[kind];
  let applicationId: string | null = null;
  let action: string | null = null;
  if (names.length) {
    // The newest application at that company that this kind of email can move; any reply also
    // resets the follow-up clock through the event it writes.
    const [rows = []] = await db.asUser(userId, [
      stmt(
        `SELECT a.id, a.state FROM mca.application a JOIN mca.job j ON j.id = a.job_id JOIN mca.company c ON c.id = j.company_id
         WHERE (c.name_norm = ANY ($1::text[]) OR c.aliases && $1::text[])
           AND a.state NOT IN ('skipped','withdrawn')
         ORDER BY (a.state = ANY ($2::text[])) DESC, a.created_at DESC LIMIT 1`,
        names, move?.from ?? [],
      ),
    ]);
    const app = rows[0];
    if (app) {
      applicationId = String(app.id);
      const canMove = move && move.from.includes(String(app.state));
      const stmts = [];
      if (canMove) {
        action = move.to;
        stmts.push(stmt(
          `WITH u AS (UPDATE mca.application SET state = $2, submitted_at = CASE WHEN $2::text = 'submitted' THEN now() ELSE submitted_at END
                      WHERE id = $1 AND state = $3 RETURNING id)
           INSERT INTO mca.application_event (user_id, application_id, kind, payload)
           SELECT $4, u.id, 'state_change', jsonb_build_object('from', $3::text, 'to', $2::text, 'via', 'email', 'subject', $5::text) FROM u`,
          applicationId, move.to, String(app.state), userId, m.subject.slice(0, 200)));
      }
      if (kind !== "application_confirmation" && kind !== "job_alert")
        stmts.push(stmt(`INSERT INTO mca.application_event (user_id, application_id, kind, payload) VALUES ($1, $2, 'employer_reply', jsonb_build_object('subject', $3::text))`,
          userId, applicationId, m.subject.slice(0, 200)));
      if (stmts.length) await db.asUser(userId, stmts);
    }
  }
  await db.asUser(userId, [
    stmt(`INSERT INTO mca.inbound_email (user_id, from_address, subject, classification, company_norm, application_id, action)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      userId, m.from.slice(0, 300), m.subject.slice(0, 500), kind, names[0] ?? null, applicationId, action),
  ]);
  return { accepted: true, kind, action, applicationId };
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
  const text = new TextDecoder().decode(buf);
  const split = text.indexOf("\r\n\r\n");
  return (split >= 0 ? text.slice(split + 4) : text).slice(0, 4_000);
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = env.TEST_DB ?? neonTenantDb(appDb(env.DATABASE_URL));
  const result = await processInbound(db, {
    to: message.to,
    from: message.headers.get("from") ?? message.from,
    subject: message.headers.get("subject") ?? "",
    body: await readSample(message.raw),
  });
  if (!result.accepted) message.setReject("Unknown recipient");
}
