import type { TenantDb } from "./lib/tenant.js";

export interface Env {
  DATABASE_URL: string;
  INGEST_DATABASE_URL: string;
  DEV_MODE: string;
  INGEST_BOARDS_PER_RUN: string;
  INBOUND_DOMAIN: string;
  /** POC auth (loop P0): "userId:token" pairs, comma-separated. Set with `wrangler secret put`. */
  API_TOKENS?: string;
  ASSETS: Fetcher;
  FILES?: R2Bucket;
  /** "false" opens sign-up to anyone; anything else requires a single-use invite code. */
  INVITE_REQUIRED?: string;
  /** PBKDF2 iterations for new password hashes, 10,000 to 100,000 (default 100,000). */
  PBKDF2_ITERATIONS?: string;
  /** Comma-separated user ids allowed to create invite codes. */
  ADMIN_USER_IDS?: string;
  /** Encrypts users' own AI provider keys. Derived at deploy time; never logged. */
  AI_KEY_SECRET?: string;
  /** Billing (beta loop B6). Off unless BILLING_ENABLED is "true" and the Stripe values are set. */
  BILLING_ENABLED?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Applications per day without a paid plan, once billing is on. */
  FREE_DAILY_LIMIT?: string;
  /** Tests only: an in-process database that replaces Neon. Never set in wrangler.toml. */
  TEST_DB?: TenantDb;
}

export type AppBindings = { Bindings: Env; Variables: { userId: string; db: TenantDb; authVia: "session" | "token" | "legacy"; sessionHash?: string } };
