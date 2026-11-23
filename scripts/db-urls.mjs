// Derives the two app login roles' passwords and connection strings from the Neon owner URL,
// so the only database secret to manage is DATABASE_OWNER_URL. Anyone holding the owner URL
// already controls the database, so deriving from it adds no new exposure. Rotating the owner
// password rotates these too (the next deploy re-applies them).
//
// Usage in GitHub Actions: `node scripts/db-urls.mjs` masks the values in the log and appends
// MCA_API_DB_PASSWORD, MCA_LOADER_DB_PASSWORD, DATABASE_URL and INGEST_DATABASE_URL to $GITHUB_ENV.
// Elsewhere it prints them as KEY=value lines.
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";

const owner = process.env.DATABASE_OWNER_URL;
if (!owner) {
  console.error("DATABASE_OWNER_URL is not set");
  process.exit(2);
}
const derive = (role) => createHmac("sha256", owner).update(`my-career-agent:${role}`).digest("base64url").slice(0, 32);
const withUser = (user, password) => {
  const u = new URL(owner);
  u.username = user;
  u.password = password;
  return u.toString();
};

const api = derive("mca_api");
const loader = derive("mca_loader");
const out = {
  MCA_API_DB_PASSWORD: api,
  MCA_LOADER_DB_PASSWORD: loader,
  DATABASE_URL: withUser("mca_api", api),
  INGEST_DATABASE_URL: withUser("mca_loader", loader),
};
const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
if (process.env.GITHUB_ENV) {
  for (const v of Object.values(out)) console.log(`::add-mask::${v}`);
  appendFileSync(process.env.GITHUB_ENV, lines);
  console.log("database credentials derived");
} else {
  process.stdout.write(lines);
}
