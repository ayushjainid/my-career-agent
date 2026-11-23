// Beta loop B3: the forwarding address, recent inbound emails, and follow-up and thank-you drafts.
// Drafts restate only what the employer already received; My Career Agent never sends them.

import { draftFollowup, followupActions, type FollowupApp } from "@my-career-agent/core";
import { Hono } from "hono";
import type { AppBindings } from "./env.js";
import { stmt } from "./lib/tenant.js";

export const followups = new Hono<AppBindings>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_DOMAIN = /\.example$/;

const candidate = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

/** The user's personal forwarding address (created on first request). */
followups.get("/inbound", async (c) => {
  const domain = (c.env.INBOUND_DOMAIN ?? "").trim();
  const configured = !!domain && !PLACEHOLDER_DOMAIN.test(domain);
  const uid = c.get("userId");
  const [[profile] = []] = await c.get("db").asUser(uid, [stmt(`SELECT count(*)::int AS n FROM mca.app_user`)]);
  if (!Number(profile?.n)) return c.json({ error: "Set up your profile first." }, 409);
  let local: string | null = null;
  for (let i = 0; i < 3 && !local; i++) {
    const [[row] = []] = await c.get("db").asSystem([stmt(`SELECT mca.inbound_route_ensure($1, $2) AS lp`, uid, candidate())]);
    local = (row?.lp as string | null) ?? null;
  }
  const [recent = []] = await c.get("db").asUser(uid, [
    stmt(`SELECT e.received_at, e.from_address, e.subject, e.classification, e.action, co.name AS company
          FROM mca.inbound_email e LEFT JOIN mca.application a ON a.id = e.application_id
          LEFT JOIN mca.job j ON j.id = a.job_id LEFT JOIN mca.company co ON co.id = j.company_id
          ORDER BY e.received_at DESC LIMIT 20`),
  ]);
  return c.json({ address: configured && local ? `${local}@${domain}` : null, configured, recent });
});

/** What to send today: follow-ups after 10 quiet days (at most two), thank-yous after interviews. */
followups.get("/followups", async (c) => {
  const uid = c.get("userId");
  const [apps = [], events = [], answers = [], me = []] = await c.get("db").asUser(uid, [
    stmt(`SELECT a.id, a.state, a.submitted_at, j.title, j.apply_url, co.id AS company_id, co.name AS company, ct.full_name AS referral_name
          FROM mca.application a JOIN mca.job j ON j.id = a.job_id JOIN mca.company co ON co.id = j.company_id
          LEFT JOIN mca.contact ct ON ct.id = a.referral_contact_id
          WHERE a.state IN ('submitted','screen','interview')`),
    stmt(`SELECT e.application_id, e.kind, e.payload, e.created_at FROM mca.application_event e
          JOIN mca.application a ON a.id = e.application_id WHERE a.state IN ('submitted','screen','interview')`),
    stmt(`SELECT application_id, submitted_text FROM mca.application_answer WHERE submitted_text IS NOT NULL`),
    stmt(`SELECT answer FROM mca.answer_bank_entry WHERE question_key = 'contact.full_name'`),
  ]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  const input: FollowupApp[] = apps.map((a) => ({
    id: String(a.id),
    state: String(a.state),
    submittedAt: a.submitted_at ? iso(a.submitted_at) : null,
    events: events
      .filter((e) => e.application_id === a.id)
      .map((e) => {
        const p = (e.payload ?? {}) as { to?: string };
        // Moving to interview counts as an interview held today, for the thank-you.
        const kind = e.kind === "state_change" && p.to === "interview" ? "interview_held" : String(e.kind);
        return { kind, at: iso(e.created_at) };
      }),
  }));
  const sender = String(me[0]?.answer ?? "").trim() || "[your name]";
  const items = followupActions(input).map((act) => {
    const a = apps.find((x) => x.id === act.appId)!;
    const submitted = answers.filter((x) => x.application_id === act.appId).map((x) => String(x.submitted_text)).join("\n");
    const firstSentence = submitted.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    const base = { appId: act.appId, companyId: a.company_id, company: a.company, title: a.title, state: a.state };
    if (act.kind === "consider_closing")
      return { ...base, kind: act.kind, daysQuiet: act.daysQuiet, sent: act.sent,
        note: `No reply in ${act.daysQuiet} days after ${act.sent} follow-up${act.sent === 1 ? "" : "s"}. Consider marking it closed and moving on.` };
    const draft = draftFollowup({
      kind: act.kind, channel: "email", company: String(a.company), role: String(a.title),
      contactName: null, submittedClaim: firstSentence || "my experience matches what the role asks for",
      submittedMaterials: submitted || firstSentence, senderName: sender,
    });
    if (!firstSentence) draft.warnings.unshift("No saved answers for this application. Replace the reminder line with something from what you sent.");
    return { ...base, kind: act.kind, ...(act.kind === "follow_up" ? { daysQuiet: act.daysQuiet, sent: act.sent } : { interviewAt: act.interviewAt }), draft };
  });
  return c.json({ items });
});

/** Record that the user sent a follow-up or thank-you. The database allows two follow-ups. */
followups.post("/followups/:appId/sent", async (c) => {
  const appId = c.req.param("appId");
  if (!UUID.test(appId)) return c.json({ error: "bad application id" }, 400);
  const b = await c.req.json<{ kind?: unknown }>().catch(() => ({}) as { kind?: unknown });
  const kind = b.kind === "thank_you" ? "thank_you_sent" : b.kind === "follow_up" ? "followup_sent" : null;
  if (!kind) return c.json({ error: "kind is follow_up or thank_you" }, 400);
  const uid = c.get("userId");
  try {
    const [rows = []] = await c.get("db").asUser(uid, [
      stmt(`INSERT INTO mca.application_event (user_id, application_id, kind)
            SELECT $1, id, $3 FROM mca.application WHERE id = $2 AND state IN ('submitted','screen','interview') RETURNING id`, uid, appId, kind),
    ]);
    return rows.length ? c.json({ ok: true }) : c.json({ error: "application not found or closed" }, 404);
  } catch (err) {
    if (/at most two follow-ups/.test(String(err))) return c.json({ error: "You've already sent two follow-ups for this application." }, 409);
    throw err;
  }
});
