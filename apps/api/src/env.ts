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
  /** Account email (password resets): the sender address, e.g. "noreply@mycareeragent.dev". */
  MAIL_FROM?: string;
  /** Cloudflare Email Service binding (send_email). Sending to any address needs Workers Paid. */
  EMAIL?: { send(m: { to: string; from: { email: string; name?: string }; subject: string; text?: string; html?: string }): Promise<unknown> };
  /** Resend API key, the free alternative to the binding. */
  RESEND_API_KEY?: string;
  /** Public base URL for links in emails, e.g. "https://app.mycareeragent.dev". */
  APP_URL?: string;
  /** Google OAuth client for "Connect Gmail" (gmail.metadata scope). Optional. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Starts the GitHub job that fetches jobs and builds queues (fine-grained token, Actions: write). */
  GITHUB_DISPATCH_TOKEN?: string;
  /** "owner/repo" holding .github/workflows/jobs.yml. */
  GITHUB_REPO?: string;
  /** Tests only: an in-process database that replaces Neon. Never set in wrangler.toml. */
  TEST_DB?: TenantDb;
  /** Tests only: the catalog connection used by ingestion, in place of INGEST_DATABASE_URL. */
  TEST_INGEST_SQL?: import("./lib/db.js").Sql;
}

export type AppBindings = { Bindings: Env; Variables: { userId: string; db: TenantDb; authVia: "session" | "token" | "legacy"; sessionHash?: string } };
