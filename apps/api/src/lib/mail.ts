// Outbound email, for account mail only (password resets). Two ways to send, picked by config:
//   - Cloudflare Email Service: the EMAIL binding (sending to any address needs Workers Paid);
//   - Resend's HTTP API: RESEND_API_KEY (free tier is enough for a beta).
// Never a relay: callers pass fixed templates; nothing here takes a recipient from a request body
// except the account's own address, looked up server-side.
import type { Env } from "../env.js";

export interface Mail { to: string; subject: string; text: string; html: string }
export type MailResult = { sent: true; via: "cloudflare" | "resend" } | { sent: false; reason: string };

export const mailConfigured = (env: Env) => !!(env.MAIL_FROM && (env.EMAIL || env.RESEND_API_KEY));

export async function sendMail(env: Env, m: Mail): Promise<MailResult> {
  const from = env.MAIL_FROM;
  if (!from) return { sent: false, reason: "MAIL_FROM is not set" };
  const fromName = "My Career Agent";
  try {
    if (env.EMAIL) {
      await env.EMAIL.send({ to: m.to, from: { email: from, name: fromName }, subject: m.subject, text: m.text, html: m.html });
      return { sent: true, via: "cloudflare" };
    }
    if (env.RESEND_API_KEY) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `${fromName} <${from}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      if (!r.ok) return { sent: false, reason: `Resend answered HTTP ${r.status}` };
      return { sent: true, via: "resend" };
    }
    return { sent: false, reason: "no mail provider configured" };
  } catch (e) {
    return { sent: false, reason: (e as { code?: string }).code ?? (e as Error).message };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** The reset email: plain, one link, says what to do if you didn't ask. */
export function resetMail(to: string, link: string, minutes: number): Mail {
  const text = [
    "Someone asked to reset the password for your My Career Agent account.",
    "",
    `Set a new password here (the link works once, for ${minutes} minutes):`,
    link,
    "",
    "If you didn't ask, ignore this email: your password stays as it is.",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#15181d;max-width:520px">
<p>Someone asked to reset the password for your My Career Agent account.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#15181d;color:#ecebe6;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Set a new password</a></p>
<p style="color:#5b6069;font-size:13px">The link works once, for ${minutes} minutes. If the button doesn't work, paste this into your browser:<br>${esc(link)}</p>
<p style="color:#5b6069;font-size:13px">If you didn't ask, ignore this email: your password stays as it is.</p></div>`;
  return { to, subject: "Reset your My Career Agent password", text, html };
}
