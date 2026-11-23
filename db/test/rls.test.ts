// Row-level security tests: run the real migration in an in-process Postgres (PGlite)
// and prove that one user can never read or write another user's data.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(migrationsDir + f, "utf8"));

let db: PGlite;

async function asUser(userId: string | null, sql: string, params: unknown[] = []) {
  // Mirrors the API: one transaction, role mca_app, user id set transaction-locally.
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL ROLE mca_app");
    if (userId) await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    return tx.query(sql, params);
  });
}

beforeAll(async () => {
  db = new PGlite();
  for (const m of migrations) await db.exec(m);
  // Seed as the owner (bypasses nothing: FORCE RLS applies, so set the user each time).
  for (const u of ["alice", "bob"]) {
    await db.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.user_id', $1, true)", [u]);
      await tx.query("INSERT INTO mca.app_user (user_id, home_country) VALUES ($1, 'US')", [u]);
      await tx.query(
        "INSERT INTO mca.fact (user_id, kind, text, verified) VALUES ($1, 'achievement', $2, true)",
        [u, `${u} shipped a thing`],
      );
    });
  }
});

describe("tenant isolation", () => {
  it("returns only the current user's rows", async () => {
    const res = await asUser("alice", "SELECT user_id, text FROM mca.fact");
    expect(res.rows).toHaveLength(1);
    expect((res.rows[0] as { user_id: string }).user_id).toBe("alice");
  });

  it("returns nothing when no user is set", async () => {
    const res = await asUser(null, "SELECT * FROM mca.fact");
    expect(res.rows).toHaveLength(0);
  });

  it("refuses to insert a row for another user", async () => {
    await expect(
      asUser("alice", "INSERT INTO mca.fact (user_id, kind, text) VALUES ('bob', 'skill', 'x')"),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update another user's rows (silently matches nothing)", async () => {
    const res = await asUser("alice", "UPDATE mca.fact SET text = 'hacked' WHERE user_id = 'bob'");
    expect(res.affectedRows ?? 0).toBe(0);
    const bob = await asUser("bob", "SELECT text FROM mca.fact");
    expect((bob.rows[0] as { text: string }).text).toBe("bob shipped a thing");
  });

  it("lets the app read the shared catalog but not write it", async () => {
    const read = await asUser("alice", "SELECT count(*)::int AS n FROM mca.job");
    expect((read.rows[0] as { n: number }).n).toBe(0);
    await expect(
      asUser("alice", "INSERT INTO mca.company (name, name_norm) VALUES ('X', 'X')"),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps the audit log append-only for the app", async () => {
    await expect(asUser("alice", "DELETE FROM mca.application_event")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("enables RLS on every table that has a user_id column", async () => {
    const res = await db.query<{ table_name: string; rls: boolean; forced: boolean }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'mca' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema = 'mca' AND col.table_name = c.relname
                      AND col.column_name = 'user_id')
        AND c.relname NOT IN ('inbound_route', 'account', 'session')`);
    expect(res.rows.length).toBeGreaterThanOrEqual(10);
    for (const row of res.rows) {
      expect(row.rls, `${row.table_name} has RLS`).toBe(true);
      expect(row.forced, `${row.table_name} forces RLS`).toBe(true);
    }
  });
});

describe("0005: account tables are unreachable except through definer functions", () => {
  it("refuses direct reads of accounts, sessions, invites and login failures", async () => {
    for (const t of ["account", "session", "invite", "login_failure"])
      await expect(asUser("alice", `SELECT * FROM mca.${t}`), t).rejects.toThrow(/permission denied/);
  });
});

describe("0002: languages, answers, follow-up cap", () => {
  it("isolates declared languages", async () => {
    await asUser("alice", "INSERT INTO mca.user_language (user_id, language, level) VALUES ('alice', 'spanish', 'native')");
    expect((await asUser("bob", "SELECT * FROM mca.user_language")).rows).toHaveLength(0);
    expect((await asUser("alice", "SELECT * FROM mca.user_language")).rows).toHaveLength(1);
  });

  it("allows at most two follow-ups per application", async () => {
    const company = await db.query<{ id: string }>("INSERT INTO mca.company (name, name_norm) VALUES ('Acme', 'ACME') RETURNING id");
    const job = await db.query<{ id: string }>(
      "INSERT INTO mca.job (company_id, ats_vendor, ats_job_id, title, description_text) VALUES ($1, 'greenhouse', '1', 'Eng', 'x') RETURNING id",
      [company.rows[0]?.id],
    );
    const app = await asUser("alice", "INSERT INTO mca.application (user_id, job_id, state) VALUES ('alice', $1, 'submitted') RETURNING id", [job.rows[0]?.id]);
    const appId = (app.rows[0] as { id: string }).id;
    const send = () => asUser("alice", "INSERT INTO mca.application_event (user_id, application_id, kind) VALUES ('alice', $1, 'followup_sent')", [appId]);
    await send();
    await send();
    await expect(send()).rejects.toThrow(/at most two follow-ups/);
  });
});
