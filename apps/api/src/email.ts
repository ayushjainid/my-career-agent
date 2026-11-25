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
  // "…the Staff Engineer role at Northwind": the company is what follows the last "at"/"with".
  const tail = /\b(?:role|position|opening|job|team)\s+(?:at|with)\s+([A-Z0-9][\w&.' -]{1,60}?)\s*[!.]?$/.exec(subject.trim());
  if (tail?.[1]) return tail[1].trim();
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
export type InboundResult = { accepted: false } | { accepted: true; kind: EmailClass | "forwarding_code"; action: string | null; applicationId: string | null; status: string | null };

export async function processInbound(db: TenantDb, m: InboundMessage): Promise<InboundResult> {
  const local = (m.to.split("@")[0] ?? "").toLowerCase();
  if (!/^[a-z0-9]{6,32}$/.test(local)) return { accepted: false };
  const [[route] = []] = await db.asSystem([stmt(`SELECT user_id FROM mca.inbound_route WHERE local_part = $1`, local)]);
  const userId = route?.user_id as string | undefined;
  if (!userId) return { accepted: false };
  const r = await processForUser(db, userId, { from: m.from, subject: m.subject, body: m.body, source: "forward" });
  return { accepted: true, kind: r.kind, action: r.action, applicationId: r.applicationId, status: r.status };
}

const ATS_SENDER = /@(?:[a-z0-9-]+\.)*(?:greenhouse\.io|greenhouse-mail\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|myworkday\.com|myworkdayjobs\.com|smartrecruiters\.com|workablemail\.com|workable\.com|icims\.com|jobvite\.com)>?\s*$/i;

/**
 * Whether a message from someone's whole inbox (Gmail) is about a job application. Forwarded mail
 * is chosen by the person; a mailbox is not, so anything else is skipped and never stored.
 */
export function isJobEmail(from: string, subject: string): boolean {
  const kind = classifyEmail(from, subject);
  return kind === "application_confirmation" || kind === "rejection" || kind === "interview_invite" || ATS_SENDER.test(from);
}

export interface UserMessage { from: string; subject: string; body?: string; source: "forward" | "gmail"; externalId?: string; receivedAt?: Date }

// Gmail's forwarding set-up sends a code to the new address; the person needs to see it.
const GMAIL_VERIFY_FROM = /forwarding-noreply@google\.com/i;
const GMAIL_VERIFY_SUBJECT = /\(#(\d{6,12})\)/;

const STOP = new Set(["the", "and", "for", "your", "you", "our", "with", "application", "applying", "role", "position", "job", "thank", "thanks", "update", "regarding", "interview", "next", "steps", "from", "team", "senior", "staff"]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
/** Share of the job title's distinctive words that appear in the subject (0 to 1). */
export function titleOverlap(subject: string, title: string): number {
  const t = words(title);
  if (!t.size) return 0;
  const sub = words(subject);
  let hit = 0;
  for (const w of t) if (sub.has(w)) hit++;
  return hit / t.size;
}
/** The role named in a confirmation subject: "Thank you for applying to the Staff Engineer role at Northwind". */
export function titleFromSubject(subject: string): string | null {
  const m = /(?:application for|applying (?:to|for)|applied (?:to|for)|interest in)\s+(?:the\s+|our\s+)?(.+?)(?:\s+(?:role|position|opening|job))?(?:\s+(?:at|with)\s+.+)?\s*[!.]?$/i.exec(subject.trim());
  const t = m?.[1]?.replace(/^(?:a|an)\s+/i, "").trim();
  return t && t.length >= 3 && t.length <= 120 && !/^(?:us|our team|this|it)$/i.test(t) ? t : null;
}
function senderDomain(from: string): string | null {
  const d = /@([a-z0-9.-]+)>?\s*$/i.exec(from)?.[1]?.toLowerCase() ?? null;
  return d && !ATS_SENDER.test(`@${d}`) ? d : null;
}

export interface Processed { kind: EmailClass | "forwarding_code"; action: string | null; applicationId: string | null; status: string | null; duplicate?: boolean }

/**
 * Reads one message for a known user and records what it proposes. Nothing moves by itself:
 *   - a stage change for a matched application becomes a pending suggestion;
 *   - a confirmation from a company you aren't tracking suggests adding that application;
 *   - Gmail's forwarding confirmation is kept so Settings can show its code;
 *   - a matched reply that changes nothing still resets that application's follow-up clock;
 *   - anything else is dropped without being stored.
 * Matching uses what the app knows about your applications (company name and aliases, company
 * domain, job title), so it works for employers that aren't on any job board.
 */
export async function processForUser(db: TenantDb, userId: string, m: UserMessage): Promise<Processed> {
  if (m.externalId) {
    const [[seen] = []] = await db.asUser(userId, [stmt(`SELECT 1 AS x FROM mca.inbound_email WHERE external_id = $1`, m.externalId)]);
    if (seen) return { kind: "other", action: null, applicationId: null, status: null, duplicate: true };
  }
  const record = (kind: string, status: string, suggestion: unknown, companyNorm: string | null, applicationId: string | null, action: string | null) =>
    db.asUser(userId, [
      stmt(`INSERT INTO mca.inbound_email (user_id, from_address, subject, classification, company_norm, application_id, action, source, external_id, received_at, status, suggestion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), $11, $12::jsonb) ON CONFLICT DO NOTHING`,
        userId, m.from.slice(0, 300), m.subject.slice(0, 500), kind, companyNorm, applicationId, action, m.source, m.externalId ?? null,
        m.receivedAt ? m.receivedAt.toISOString() : null, status, suggestion === null ? null : JSON.stringify(suggestion)),
    ]);

  if (GMAIL_VERIFY_FROM.test(m.from) && GMAIL_VERIFY_SUBJECT.test(m.subject)) {
    const code = GMAIL_VERIFY_SUBJECT.exec(m.subject)![1];
    const link = /https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s"'<>]+/.exec(m.body ?? "")?.[0] ?? null;
    await record("forwarding_code", "info", { code, link }, null, null, null);
    return { kind: "forwarding_code", action: null, applicationId: null, status: "info" };
  }

  const kind = classifyEmail(m.from, m.subject, m.body ?? "");
  const rawNames = [companyFromSubject(m.subject), companyFromSender(m.from)].filter((x): x is string => !!x);
  const names = rawNames.map(normalizeCompanyName).filter(Boolean);
  const domain = senderDomain(m.from);
  const move = MOVES[kind];

  let app: { id: string; state: string } | null = null;
  if (names.length || domain) {
    const [rows = []] = await db.asUser(userId, [
      stmt(
        `SELECT a.id, a.state, j.title, a.created_at FROM mca.application a JOIN mca.job j ON j.id = a.job_id JOIN mca.company c ON c.id = j.company_id
         WHERE a.state NOT IN ('skipped','withdrawn')
           AND (c.name_norm = ANY ($1::text[]) OR c.aliases && $1::text[]
                OR ($2::text IS NOT NULL AND c.domain IS NOT NULL AND ($2::text = lower(c.domain) OR $2::text LIKE '%.' || lower(c.domain))))
         ORDER BY a.created_at DESC LIMIT 25`,
        names, domain,
      ),
    ]);
    // Several applications at one company: the job title in the subject decides, then whether
    // this email can move it, then the newest.
    const ranked = rows
      .map((r) => ({ id: String(r.id), state: String(r.state), score: titleOverlap(m.subject, String(r.title)) * 2 + (move?.from.includes(String(r.state)) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score);
    app = ranked[0] ?? null;
  }

  if (app) {
    if (move && move.from.includes(app.state)) {
      await record(kind, "pending", { to: move.to, from: app.state }, names[0] ?? null, app.id, null);
      return { kind, action: null, applicationId: app.id, status: "pending" };
    }
    // Nothing to move, but a reply still counts as contact for follow-up timing.
    if (kind !== "application_confirmation" && kind !== "job_alert")
      await db.asUser(userId, [stmt(`INSERT INTO mca.application_event (user_id, application_id, kind, payload) VALUES ($1, $2, 'employer_reply', jsonb_build_object('subject', $3::text))`,
        userId, app.id, m.subject.slice(0, 200))]);
    await record(kind, "info", null, names[0] ?? null, app.id, null);
    return { kind, action: null, applicationId: app.id, status: "info" };
  }

  if (kind === "application_confirmation" && rawNames[0]) {
    await record(kind, "pending", { company: rawNames[0], norm: names[0], title: titleFromSubject(m.subject) }, names[0] ?? null, null, null);
    return { kind, action: null, applicationId: null, status: "pending" };
  }
  // Not about anything you're tracking: dropped, never stored.
  return { kind, action: null, applicationId: null, status: null };
}

/** Accepting a suggestion applies it now, if the application is still where it was. */
export async function acceptSuggestion(db: TenantDb, userId: string, id: number): Promise<{ ok: boolean; applicationId?: string; error?: string }> {
  const [[row] = []] = await db.asUser(userId, [stmt(`SELECT id, status, suggestion, application_id, subject FROM mca.inbound_email WHERE id = $1`, id)]);
  if (!row || row.status !== "pending") return { ok: false, error: "That suggestion is no longer open." };
  const s = (row.suggestion ?? {}) as { to?: string; from?: string; company?: string; norm?: string; title?: string | null };
  if (s.to && row.application_id) {
    const [[moved] = []] = await db.asUser(userId, [
      stmt(`WITH u AS (UPDATE mca.application SET state = $2, submitted_at = CASE WHEN $2::text = 'submitted' THEN coalesce(submitted_at, now()) ELSE submitted_at END
                       WHERE id = $1 AND state = $3 RETURNING id)
            INSERT INTO mca.application_event (user_id, application_id, kind, payload)
            SELECT $4, u.id, 'state_change', jsonb_build_object('from', $3::text, 'to', $2::text, 'via', 'email', 'subject', $5::text) FROM u RETURNING application_id`,
        row.application_id, s.to, s.from, userId, String(row.subject ?? "").slice(0, 200)),
    ]);
    if (!moved) {
      await db.asUser(userId, [stmt(`UPDATE mca.inbound_email SET status = 'ignored' WHERE id = $1`, id)]);
      return { ok: false, error: "That application has moved since this email arrived, so nothing changed." };
    }
    await db.asUser(userId, [stmt(`UPDATE mca.inbound_email SET status = 'accepted', action = $2 WHERE id = $1`, id, s.to)]);
    return { ok: true, applicationId: String(row.application_id) };
  }
  if (s.company && s.norm) {
    const [[t] = []] = await db.asUser(userId, [stmt(`SELECT mca.track_external($1, $2, $3) AS id`, s.company, s.norm, s.title ?? null)]);
    // Close this one and any duplicates for the same company (the same confirmation forwarded twice).
    await db.asUser(userId, [stmt(`UPDATE mca.inbound_email SET status = 'accepted', action = 'added', application_id = $2
                                   WHERE id = $1 OR (status = 'pending' AND application_id IS NULL AND suggestion->>'norm' = $3)`, id, t?.id, s.norm)]);
    return { ok: true, applicationId: String(t?.id) };
  }
  return { ok: false, error: "That suggestion can't be applied." };
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
