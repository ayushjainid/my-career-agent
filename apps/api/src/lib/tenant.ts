// A tiny database seam: run parameterised statements as one user, in one transaction, under
// row-level security. Production uses Neon over HTTP; tests use an in-process Postgres (PGlite)
// with the real migrations, so the same SQL is exercised end to end before it is deployed.

import type { Sql } from "./db.js";

export interface Stmt {
  text: string;
  params?: unknown[];
}

export type Row = Record<string, unknown>;

export interface TenantDb {
  /** Runs all statements in one transaction with app.user_id set; returns rows per statement. */
  asUser(userId: string, stmts: Stmt[]): Promise<Row[][]>;
}

export const stmt = (text: string, ...params: unknown[]): Stmt => ({ text, params });

export function neonTenantDb(sql: Sql): TenantDb {
  return {
    async asUser(userId, stmts) {
      if (!userId) throw new Error("asUser requires a user id");
      const results = await sql.transaction([
        sql("SELECT set_config('app.user_id', $1, true)", [userId]),
        ...stmts.map((s) => sql(s.text, s.params ?? [])),
      ]);
      return results.slice(1) as Row[][];
    },
  };
}
