// Shared end-to-end test harness: real routes, real migrations, row-level security on,
// an in-process Postgres (PGlite) standing in for Neon.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env.js";
import { app } from "../src/index.js";
import type { Row, TenantDb } from "../src/lib/tenant.js";

export const TOKEN_A = "a".repeat(20) + "-token-alice";
export const TOKEN_B = "b".repeat(20) + "-token-bob";

export function pgliteTenantDb(db: PGlite): TenantDb {
  return {
    asUser: (userId, stmts) =>
      db.transaction(async (tx) => {
        await tx.query("SET LOCAL ROLE mca_app");
        await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        const out: Row[][] = [];
        for (const s of stmts) out.push((await tx.query<Row>(s.text, s.params ?? [])).rows);
        return out;
      }),
  };
}

export async function harness() {
  const pg = new PGlite();
  const dir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(dir + f, "utf8"));
  const env: Env = {
    DATABASE_URL: "unused",
    INGEST_DATABASE_URL: "unused",
    DEV_MODE: "false",
    INGEST_BOARDS_PER_RUN: "1",
    INBOUND_DOMAIN: "in.example",
    API_TOKENS: `alice:${TOKEN_A},bob:${TOKEN_B}`,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    TEST_DB: pgliteTenantDb(pg),
  };
  const call = (method: string, path: string, token: string | null, body?: unknown) =>
    app.fetch(
      new Request(`http://mca.test/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  const json = async (r: Response) => (await r.json()) as Record<string, any>;

  /** Adds a company, one open US job and sponsor filings; returns their ids. */
  const addCompany = async (name: string, aliases: string[] = [], description = "Requirements\n- 5+ years of Python\n- SQL\n- AWS") => {
    const { rows } = await pg.query<{ id: string }>(
      "INSERT INTO mca.company (name, name_norm, aliases, ats_vendor, ats_board) VALUES ($1, upper($1), $2, 'greenhouse', lower($1)) RETURNING id",
      [name, aliases],
    );
    const companyId = rows[0]!.id;
    const job = await pg.query<{ id: string }>(
      `INSERT INTO mca.job (company_id, ats_vendor, ats_job_id, title, country, description_text, apply_url, posted_at, status, integrity)
       VALUES ($1, 'greenhouse', $2, 'Senior Data Engineer', 'US', $3, $4, now() - interval '2 days', 'open', '{"level":"clean","verdict":"clean"}')
       RETURNING id`,
      [companyId, `${name}-1`, description, `https://boards.greenhouse.io/${name.toLowerCase()}/jobs/1`],
    );
    await pg.query(
      `INSERT INTO mca.sponsor_record (company_id, country, source, employer_name, employer_norm, filings, certified, period_end)
       VALUES ($1, 'US', 'dol_lca', $2, upper($2), 50, 0, '2026-09-30'), ($1, 'US', 'dol_perm', $2, upper($2), 0, 10, '2026-09-30')`,
      [companyId, name],
    );
    return { companyId, jobId: job.rows[0]!.id };
  };

  /** A minimal profile that queues the seeded jobs. */
  const setupProfile = async (token: string) => {
    await call("PUT", "/profile", token, { homeCountry: "US", dailyTarget: 10 });
    const r = await json(await call("POST", "/facts", token, [
      { kind: "role", text: "Data engineer at Hooli, cut pipeline cost by 40% for 3M users", skills: ["python", "sql", "aws"], startDate: "2018-01-01", verified: true },
    ]));
    await call("PUT", "/languages", token, [{ language: "English", level: "C2" }]);
    await call("PUT", "/work-auth/US", token, { status: "needs_sponsorship" });
    await call("POST", "/targets", token, { country: "US", title: "Data Engineer", seniority: "senior" });
    return r.ids as string[];
  };

  return { pg, env, call, json, addCompany, setupProfile };
}
