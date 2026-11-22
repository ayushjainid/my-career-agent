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
  /** Tests only: an in-process database that replaces Neon. Never set in wrangler.toml. */
  TEST_DB?: TenantDb;
}

export type AppBindings = { Bindings: Env; Variables: { userId: string; db: TenantDb } };
