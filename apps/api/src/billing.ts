// Beta loop B6: Stripe billing, built and switched off. With BILLING_ENABLED unset everyone is on
// the free beta and nothing is limited. Turning it on needs STRIPE_SECRET_KEY, STRIPE_PRICE_ID and
// STRIPE_WEBHOOK_SECRET, and a decision on FREE_DAILY_LIMIT. No card details touch this server.

import { Hono } from "hono";
import type { AppBindings, Env } from "./env.js";
import { stmt, type TenantDb } from "./lib/tenant.js";

export const billing = new Hono<AppBindings>();
export const stripeWebhook = new Hono<AppBindings>();

const ACTIVE = new Set(["active", "trialing"]);
export const billingEnabled = (env: Env) => env.BILLING_ENABLED === "true" && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_PRICE_ID;

/** The day's application ceiling under the current plan; null means no limit. */
export async function dailyLimit(env: Env, db: TenantDb, uid: string): Promise<number | null> {
  if (!billingEnabled(env)) return null;
  const [[s] = []] = await db.asUser(uid, [stmt(`SELECT status FROM mca.subscription`)]);
  if (s && ACTIVE.has(String(s.status))) return null;
  return Math.max(0, Number(env.FREE_DAILY_LIMIT ?? 3) || 3);
}

async function stripe(env: Env, path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!r.ok) throw new Error(data.error?.message ?? `Stripe ${r.status}`);
  return data;
}

billing.get("/billing", async (c) => {
  const enabled = billingEnabled(c.env);
  const [[s] = []] = await c.get("db").asUser(c.get("userId"), [stmt(`SELECT status, current_period_end FROM mca.subscription`)]);
  return c.json({
    enabled,
    plan: !enabled ? "free_beta" : s && ACTIVE.has(String(s.status)) ? "paid" : "free",
    status: s?.status ?? null,
    renewsOn: s?.current_period_end ?? null,
    dailyLimit: await dailyLimit(c.env, c.get("db"), c.get("userId")),
  });
});

billing.post("/billing/checkout", async (c) => {
  if (!billingEnabled(c.env)) return c.json({ error: "Billing is off during the free beta." }, 409);
  const origin = new URL(c.req.url).origin;
  const s = await stripe(c.env, "checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": c.env.STRIPE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    client_reference_id: c.get("userId"),
    success_url: `${origin}/#/settings?billing=done`,
    cancel_url: `${origin}/#/settings`,
    allow_promotion_codes: "true",
  });
  return c.json({ url: s.url });
});

billing.post("/billing/portal", async (c) => {
  if (!billingEnabled(c.env)) return c.json({ error: "Billing is off during the free beta." }, 409);
  const [[s] = []] = await c.get("db").asUser(c.get("userId"), [stmt(`SELECT stripe_customer_id FROM mca.subscription`)]);
  if (!s) return c.json({ error: "No subscription yet." }, 404);
  const p = await stripe(c.env, "billing_portal/sessions", { customer: String(s.stripe_customer_id), return_url: `${new URL(c.req.url).origin}/#/settings` });
  return c.json({ url: p.url });
});

/** Verifies Stripe-Signature (HMAC-SHA256 of "t.payload", 5-minute tolerance), constant time. */
export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const sigs = (header ?? "").split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === mac.length && [...s].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0);
}

stripeWebhook.post("/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return c.json({ error: "billing not configured" }, 404);
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header("stripe-signature"), c.env.STRIPE_WEBHOOK_SECRET))) return c.json({ error: "bad signature" }, 400);
  const event = JSON.parse(payload) as { type: string; data: { object: Record<string, any> } };
  const o = event.data.object;
  const db = c.get("db");
  const apply = (userId: string | null, customer: string, sub: string | null, status: string, price: string | null, end: number | null) =>
    db.asSystem([stmt(`SELECT mca.subscription_apply($1, $2, $3, $4, $5, $6) AS r`, userId, customer, sub, status, price, end ? new Date(end * 1000).toISOString() : null)]);
  if (event.type === "checkout.session.completed" && o.mode === "subscription")
    await apply(o.client_reference_id ?? null, String(o.customer), o.subscription ? String(o.subscription) : null, "active", null, null);
  else if (event.type.startsWith("customer.subscription."))
    await apply(null, String(o.customer), String(o.id), event.type === "customer.subscription.deleted" ? "canceled" : String(o.status),
      o.items?.data?.[0]?.price?.id ?? null, o.current_period_end ?? o.items?.data?.[0]?.current_period_end ?? null);
  return c.json({ received: true });
});
