/**
 * Create (or promote) a platform-admin account — Vexora staff.
 *
 *   node scripts/create-platform-admin.mjs <email> <password>
 *   node scripts/create-platform-admin.mjs admin@example.com 'S3cret!'
 *
 * Platform admins are deliberately NOT creatable through signup: no public
 * endpoint can grant platform access, so staff are provisioned out-of-band
 * with this script.
 *
 * They get no organization on purpose. A platform admin administers other
 * workspaces rather than owning one, so the app shows them the admin area
 * only. Re-running for an existing email promotes that account and resets
 * its password.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import pg from "pg";

const [, , emailArg, passwordArg] = process.argv;

if (!emailArg || !passwordArg) {
  console.error(
    "usage: node scripts/create-platform-admin.mjs <email> <password>"
  );
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const password = passwordArg;

if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  console.error(`"${email}" is not a valid email address.`);
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

// Same cost as the app's own hashing (services/auth/password.ts).
const passwordHash = await bcrypt.hash(password, 12);

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const { rows } = await pool.query(
    `insert into users (email, password_hash, name, role)
          values ($1, $2, $3, 'platform_admin')
     on conflict (email) do update
        set role = 'platform_admin',
            password_hash = excluded.password_hash
     returning id, email, role, (xmax = 0) as created`,
    [email, passwordHash, "Platform Admin"]
  );

  const user = rows[0];

  // Any existing sessions must not keep the old (lower) role or password.
  await pool.query(
    `update refresh_tokens set revoked_at = now()
      where user_id = $1 and revoked_at is null`,
    [user.id]
  );

  console.log(
    `${user.created ? "Created" : "Promoted"} platform admin: ${user.email}`
  );
  console.log(
    "They have no workspace by design — after logging in they land on the admin area."
  );
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
