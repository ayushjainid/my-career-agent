// Run the whole app on your machine with no Neon or Cloudflare account: the real API and web
// app, the real migrations, and an in-process Postgres (PGlite) seeded with demo data.
//   npx tsx scripts/dev-local.mts        then open http://localhost:8788 and sign in with the token printed
// Data lives in memory and is gone when you stop it.
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../apps/api/src/env.js";
import { app } from "../apps/api/src/index.js";
import type { Row, TenantDb } from "../apps/api/src/lib/tenant.js";

const PORT = Number(process.env.PORT ?? 8788);
const TOKEN = "local-dev-token-0000000000000000";
const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "apps/api/public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

const pg = new PGlite();
for (const f of readdirSync(join(root, "db/migrations")).filter((f) => f.endsWith(".sql")).sort())
  await pg.exec(readFileSync(join(root, "db/migrations", f), "utf8"));

// Demo catalog: a few companies with one open job each and US sponsor filings.
const demo: Array<[string, string]> = [
  ["Acme", "Requirements\n- 5+ years of Python\n- SQL\n- AWS\nNice to have\n- Kubernetes"],
  ["Globex", "Requirements\n- Python\n- Spark\n- SQL\nWe sponsor visas."],
  ["Initech", "Requirements\n- Python\n- SQL\nFluent German required."],
  ["Hooli", "Requirements\n- 7+ years of Python\n- Go\n- Kafka"],
  ["Northwind", "Requirements\n- Python\n- SQL\n- Airflow"],
  ["Contoso", "Requirements\n- Python\n- SQL\n- dbt"],
  ["Fabrikam", "Requirements\n- Python\n- AWS\n- SQL"],
  ["Tailspin", "Requirements\n- Python\n- SQL\n- Snowflake"],
];
for (const [i, [name, desc]] of demo.entries()) {
  const { rows } = await pg.query<{ id: string }>(
    "INSERT INTO mca.company (name, name_norm, ats_vendor, ats_board) VALUES ($1, upper($1), 'greenhouse', lower($1)) RETURNING id", [name]);
  await pg.query(
    `INSERT INTO mca.job (company_id, ats_vendor, ats_job_id, title, country, location_text, remote_type, description_text, apply_url,
       posted_at, status, pay_min, pay_max, pay_currency, integrity)
     VALUES ($1, 'greenhouse', $2, 'Senior Data Engineer', 'US', 'New York, NY', 'hybrid', $3, $4, now() - interval '1 day', 'open',
       160000, 210000, 'USD', '{"level":"clean","verdict":"clean"}')`,
    [rows[0]!.id, String(i + 1), desc, `https://boards.greenhouse.io/${name.toLowerCase()}/jobs/${i + 1}`]);
  await pg.query(
    `INSERT INTO mca.sponsor_record (company_id, country, source, employer_name, employer_norm, filings, certified, period_end)
     VALUES ($1, 'US', 'dol_lca', $2, upper($2), 40, 0, '2026-09-30'), ($1, 'US', 'dol_perm', $2, upper($2), 0, 8, '2026-09-30')`,
    [rows[0]!.id, name]);
}

const db: TenantDb = {
  asUser: (userId, stmts) =>
    pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE mca_app");
      await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const out: Row[][] = [];
      for (const s of stmts) out.push((await tx.query<Row>(s.text, s.params ?? [])).rows);
      return out;
    }),
  asSystem: (stmts) =>
    pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE mca_app");
      const out: Row[][] = [];
      for (const s of stmts) out.push((await tx.query<Row>(s.text, s.params ?? [])).rows);
      return out;
    }),
};

const assets = {
  async fetch(req: Request) {
    const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(publicDir, path === "/" ? "index.html" : path);
    try {
      return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
    } catch {
      return new Response(readFileSync(join(publicDir, "index.html")), { headers: { "content-type": TYPES[".html"]! } });
    }
  },
} as unknown as Fetcher;

const env: Env = {
  DATABASE_URL: "local", INGEST_DATABASE_URL: "local", DEV_MODE: "false", INGEST_BOARDS_PER_RUN: "0",
  INBOUND_DOMAIN: "in.localhost", API_TOKENS: `me:${TOKEN}`, ASSETS: assets, TEST_DB: db,
  INVITE_REQUIRED: "false", PBKDF2_ITERATIONS: "20000", AI_KEY_SECRET: "local-dev-only-ai-key-secret-0123456789",
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await app.fetch(new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`My Career Agent (local): http://localhost:${PORT}\nSign in with: ${TOKEN}`));
