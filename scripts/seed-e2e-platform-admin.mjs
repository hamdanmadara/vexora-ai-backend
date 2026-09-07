/**
 * Creates (or re-promotes) a platform-admin account for the Playwright suite.
 *
 *   node scripts/seed-e2e-platform-admin.mjs
 *
 * Platform admins are deliberately not creatable through signup, so the browser
 * tests need one seeded the same way real staff are: signed up normally, then
 * promoted in SQL. Prints the credentials for the spec to consume via
 * E2E_PLATFORM_EMAIL / E2E_PLATFORM_PASSWORD.
 */
import "dotenv/config";
import pg from "pg";

const API = process.env.API ?? "http://localhost:4000/api";
const email = process.env.E2E_PLATFORM_EMAIL ?? "e2e-platform@test.dev";
const password = process.env.E2E_PLATFORM_PASSWORD ?? "playwright123";

const res = await fetch(`${API}/auth/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    accountType: "personal",
    name: "E2E Platform Admin",
    email,
    password,
  }),
});

if (!res.ok && res.status !== 409) {
  console.error(`signup failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
const { rowCount } = await pool.query(
  `update users set role = 'platform_admin' where email = $1`,
  [email]
);
await pool.end();

if (!rowCount) {
  console.error(`no user found for ${email}`);
  process.exit(1);
}

console.log(`platform admin ready: ${email} / ${password}`);
