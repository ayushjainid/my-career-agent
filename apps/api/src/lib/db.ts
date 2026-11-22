// Database access. Two connection strings, two roles:
//   DATABASE_URL        -> login role in lv_app: tenant data behind row-level security
//   INGEST_DATABASE_URL -> login role in lv_ingest: writes the shared catalog only
// Every tenant query runs in one transaction that first sets app.user_id, so RLS policies apply.

import { neon, type NeonQueryFunction, type NeonQueryPromise } from "@neondatabase/serverless";

export type Sql = NeonQueryFunction<false, false>;
type Query = NeonQueryPromise<false, false>;

export function appDb(url: string): Sql {
  return neon(url);
}

/**
 * Runs queries as a given user. The user id is set transaction-locally (set_config(..., true)),
 * so it cannot leak into another request even on a pooled connection.
 */
export async function withUser<T extends unknown[]>(
  sql: Sql,
  userId: string,
  build: (sql: Sql) => Query[],
): Promise<T> {
  if (!userId) throw new Error("withUser requires a user id");
  const results = await sql.transaction([sql`SELECT set_config('app.user_id', ${userId}, true)`, ...build(sql)]);
  return results.slice(1) as T;
}
