// POC loop P4: import the user's LinkedIn export, match people to catalog companies, and show
// who could refer them for each job. The user sends every message themselves.

import { contactStrength, draftReferralAsk, parseLinkedInExport } from "@my-career-agent/core";
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { stmt } from "./lib/tenant.js";

export const referrals = new Hono<AppBindings>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const BATCH = 1000;

/**
 * Body: { connectionsCsv: string, messagesCsv?: string }. Upserts by person, keeps "last asked"
 * dates, and matches each contact's company against catalog names and aliases.
 */
referrals.post("/connections/import", async (c) => {
  const b = await c.req.json<{ connectionsCsv?: unknown; messagesCsv?: unknown }>().catch(() => null);
  const conn = typeof b?.connectionsCsv === "string" ? b.connectionsCsv : "";
  const msgs = typeof b?.messagesCsv === "string" ? b.messagesCsv : null;
  if (!conn) return c.json({ error: "connectionsCsv is required (the text of Connections.csv)" }, 400);
  if (conn.length + (msgs?.length ?? 0) > MAX_CSV_BYTES) return c.json({ error: "files are larger than 8 MB" }, 413);

  let parsed;
  try {
    parsed = parseLinkedInExport(conn, msgs);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "could not read the file" }, 400);
  }
  const uid = c.get("userId");
  const db = c.get("db");
  const stmts = [];
  for (let i = 0; i < parsed.connections.length; i += BATCH) {
    const rows = parsed.connections.slice(i, i + BATCH).map((p) => ({
      key: p.key, full_name: p.fullName, profile_url: p.profileUrl, email: p.email, company_name: p.companyName,
      company_norm: p.companyNorm, position: p.position, connected_on: p.connectedOn,
      messages_count: p.messagesCount, last_message_at: p.lastMessageAt,
    }));
    stmts.push(
      stmt(
        `INSERT INTO mca.contact (user_id, source_key, full_name, profile_url, email, company_name, company_norm, company_id,
                                  position, connected_on, messages_count, last_message_at, imported_at)
         SELECT $1, x.key, x.full_name, x.profile_url, x.email, x.company_name, x.company_norm,
                (SELECT co.id FROM mca.company co
                  WHERE x.company_norm IS NOT NULL AND (co.name_norm = x.company_norm OR x.company_norm = ANY (co.aliases))
                  ORDER BY (co.name_norm = x.company_norm) DESC, co.id LIMIT 1),
                x.position, x.connected_on, x.messages_count, x.last_message_at, now()
         FROM jsonb_to_recordset($2::jsonb) AS x(key text, full_name text, profile_url text, email text, company_name text,
              company_norm text, position text, connected_on date, messages_count int, last_message_at date)
         ON CONFLICT (user_id, source_key) DO UPDATE SET
           full_name = EXCLUDED.full_name, profile_url = EXCLUDED.profile_url, email = EXCLUDED.email,
           company_name = EXCLUDED.company_name, company_norm = EXCLUDED.company_norm, company_id = EXCLUDED.company_id,
           position = EXCLUDED.position, connected_on = EXCLUDED.connected_on,
           -- a newer export without messages.csv must not wipe counts from an earlier one
           messages_count = CASE WHEN $3::boolean THEN EXCLUDED.messages_count ELSE mca.contact.messages_count END,
           last_message_at = CASE WHEN $3::boolean THEN EXCLUDED.last_message_at ELSE mca.contact.last_message_at END,
           imported_at = now()`,
        uid, JSON.stringify(rows), parsed.messageFileUsed,
      ),
    );
  }
  stmts.push(
    stmt(`SELECT count(*)::int AS total, count(company_id)::int AS matched, count(DISTINCT company_id)::int AS companies FROM mca.contact`),
  );
  const results = await db.asUser(uid, stmts);
  const summary = results.at(-1)?.[0] ?? {};
  return c.json({
    imported: parsed.connections.length,
    skipped: parsed.skipped,
    messagesUsed: parsed.messageFileUsed,
    warnings: parsed.warnings,
    ...summary,
  });
});

/** Contacts grouped by matched company, strongest first. */
referrals.get("/connections", async (c) => {
  const [rows = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT ct.id, ct.full_name, ct.position, ct.company_name, co.name AS company, ct.messages_count,
                 ct.last_message_at::text AS last_message_at, ct.connected_on::text AS connected_on, ct.last_ask_at::text AS last_ask_at
          FROM mca.contact ct LEFT JOIN mca.company co ON co.id = ct.company_id
          WHERE ct.company_id IS NOT NULL ORDER BY co.name, ct.messages_count DESC, ct.full_name LIMIT 2000`),
  ]);
  return c.json({ items: rows });
});

/** Who could refer the user for this job, ranked, each with a drafted ask to edit and send. */
referrals.get("/referrals/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!UUID.test(jobId)) return c.json({ error: "bad job id" }, 400);
  const [jobs = [], contacts = [], me = []] = await c.get("db").asUser(c.get("userId"), [
    stmt(`SELECT j.title, j.apply_url, co.name AS company FROM mca.job j JOIN mca.company co ON co.id = j.company_id WHERE j.id = $1`, jobId),
    stmt(`SELECT ct.id, ct.full_name, ct.position, ct.profile_url, ct.messages_count, ct.last_message_at::text AS last_message_at,
                 ct.connected_on::text AS connected_on, ct.last_ask_at::text AS last_ask_at
          FROM mca.contact ct JOIN mca.job j ON j.company_id = ct.company_id WHERE j.id = $1`, jobId),
    stmt(`SELECT answer FROM mca.answer_bank_entry WHERE question_key = 'contact.full_name'`),
  ]);
  const job = jobs[0];
  if (!job) return c.json({ error: "job not found" }, 404);
  const today = new Date();
  const sender = String(me[0]?.answer ?? "").trim() || "[your name]";
  const items = contacts
    .map((ct) => {
      const strength = contactStrength(
        {
          companyId: "",
          messagesCount: Number(ct.messages_count ?? 0),
          lastMessageAt: (ct.last_message_at as string | null) ?? null,
          connectedOn: (ct.connected_on as string | null) ?? null,
          lastAskAt: (ct.last_ask_at as string | null) ?? null,
        },
        today,
      );
      const full = String(ct.full_name);
      return {
        ...ct,
        full_name: full,
        strength,
        draft: draftReferralAsk({
          contactFirstName: full.split(/\s+/)[0] ?? full,
          company: String(job.company),
          role: String(job.title),
          jobUrl: (job.apply_url as string | null) ?? null,
          senderName: sender,
          warm: Number(ct.messages_count ?? 0) > 0,
        }),
      };
    })
    .sort((a, b) => b.strength - a.strength || String(a.full_name).localeCompare(String(b.full_name)));
  return c.json({ job, items });
});

/** Record that the user asked this person: links them to the application and dates the ask. */
referrals.post("/applications/:id/referral", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ contactId?: unknown }>().catch(() => null);
  const contactId = typeof b?.contactId === "string" ? b.contactId : "";
  if (!UUID.test(id) || !UUID.test(contactId)) return c.json({ error: "bad application or contact id" }, 400);
  const uid = c.get("userId");
  const [updated = []] = await c.get("db").asUser(uid, [
    stmt(
      `WITH ct AS (UPDATE mca.contact SET last_ask_at = current_date
                  WHERE id = $2 AND EXISTS (SELECT 1 FROM mca.application WHERE id = $1) RETURNING id)
       UPDATE mca.application a SET referral_contact_id = ct.id FROM ct WHERE a.id = $1 RETURNING a.id`,
      id, contactId,
    ),
  ]);
  if (!updated.length) return c.json({ error: "application or contact not found" }, 404);
  await c.get("db").asUser(uid, [
    stmt(`INSERT INTO mca.application_event (user_id, application_id, kind, payload) VALUES ($1, $2, 'referral_asked', $3::jsonb)`,
      uid, id, JSON.stringify({ contactId })),
  ]);
  return c.json({ ok: true });
});
