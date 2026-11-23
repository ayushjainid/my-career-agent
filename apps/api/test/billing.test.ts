// Beta loop B6: billing ships off; when on, the webhook is verified and limits apply.
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index.js";
import { verifyStripeSignature } from "../src/billing.js";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
const SECRET = "whsec_test_0123456789";

async function sign(payload: string, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${mac}`;
}
const webhook = async (event: unknown, sig?: string) => {
  const body = JSON.stringify(event);
  return app.fetch(new Request("http://mca.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": sig ?? (await sign(body)) }, body }), h.env);
};

beforeAll(async () => {
  h = await harness();
  for (const n of ["A1", "A2", "A3", "A4", "A5"]) await h.addCompany(`Co${n}`);
  await h.setupProfile(TOKEN_A);
});

describe("billing off (the free beta)", () => {
  it("limits nothing and refuses checkout", async () => {
    expect(await h.json(await h.call("GET", "/billing", TOKEN_A))).toMatchObject({ enabled: false, plan: "free_beta", dailyLimit: null });
    expect((await h.call("POST", "/billing/checkout", TOKEN_A)).status).toBe(409);
    expect((await h.json(await h.call("POST", "/queue/build", TOKEN_A))).queued).toBe(5);
  });
});

describe("billing on", () => {
  it("verifies Stripe signatures with a time tolerance", async () => {
    expect(await verifyStripeSignature("{}", await sign("{}"), SECRET)).toBe(true);
    expect(await verifyStripeSignature("{}", await sign("{}", Math.floor(Date.now() / 1000) - 600), SECRET)).toBe(false);
    expect(await verifyStripeSignature("{}", "t=1,v1=00", SECRET)).toBe(false);
  });

  it("caps the free tier, and a verified subscription lifts the cap", async () => {
    Object.assign(h.env, { BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_x", STRIPE_WEBHOOK_SECRET: SECRET, FREE_DAILY_LIMIT: "2" });
    await h.pg.query("DELETE FROM mca.application");
    expect((await h.json(await h.call("POST", "/queue/build", TOKEN_A))).queued).toBe(2);
    expect((await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "alice", customer: "cus_1", subscription: "sub_1" } } }, "t=1,v1=bad")).status).toBe(400);
    expect((await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "alice", customer: "cus_1", subscription: "sub_1" } } })).status).toBe(200);
    expect(await h.json(await h.call("GET", "/billing", TOKEN_A))).toMatchObject({ enabled: true, plan: "paid", dailyLimit: null });
    await webhook({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } });
    expect(await h.json(await h.call("GET", "/billing", TOKEN_A))).toMatchObject({ plan: "free", dailyLimit: 2 });
  });
});
