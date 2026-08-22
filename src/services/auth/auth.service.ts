import bcrypt from "bcryptjs";
import { getPool } from "@/db/pool";
import { env } from "@/config/env";
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "./token.service";

const BCRYPT_ROUNDS = 12;

export type UserRole = "user" | "admin";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: UserRole;
  company_name: string | null;
  company_description: string | null;
  created_at: string;
  updated_at: string;
}

/** The shape that ever leaves the API — password hash stripped. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  companyName: string | null;
  companyDescription: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires — lets the client refresh early. */
  expiresIn: number;
}

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    companyName: row.company_name,
    companyDescription: row.company_description,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Login throttling: 5 failures per email+IP → 15-minute lockout. In-memory
// (single instance today); a shared store is the multi-instance follow-up.
// ---------------------------------------------------------------------------

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

function throttleKey(email: string, ip: string): string {
  return `${email}|${ip}`;
}

function assertNotLocked(email: string, ip: string): void {
  const entry = failures.get(throttleKey(email, ip));
  if (entry && entry.lockedUntil > Date.now()) {
    const minutes = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
    throw new UnauthorizedError(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
    );
  }
}

function recordFailure(email: string, ip: string): void {
  const key = throttleKey(email, ip);
  const entry = failures.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failures.set(key, entry);
  // Bounded memory: reset wholesale rather than tracking eviction order.
  if (failures.size > 10_000) failures.clear();
}

function clearFailures(email: string, ip: string): void {
  failures.delete(throttleKey(email, ip));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertValidSignup(email: string, password: string, name: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestError("Please enter a valid email address.");
  }
  if (password.length < 8) {
    throw new BadRequestError("Password must be at least 8 characters.");
  }
  if (password.length > 128) {
    throw new BadRequestError("Password must be at most 128 characters.");
  }
  if (name.trim().length < 2) {
    throw new BadRequestError("Please enter your name.");
  }
}

// ---------------------------------------------------------------------------
// Refresh-token persistence
// ---------------------------------------------------------------------------

async function issueTokens(user: UserRow): Promise<AuthTokens> {
  const pool = getPool();
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(
    Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000
  );

  await pool.query(
    `insert into refresh_tokens (user_id, token_hash, expires_at)
     values ($1, $2, $3)`,
    [user.id, hashRefreshToken(refreshToken), expiresAt]
  );

  return {
    accessToken: signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    }),
    refreshToken,
    expiresIn: env.JWT_ACCESS_TTL_MIN * 60,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function signup(input: {
  email: string;
  password: string;
  name: string;
  companyName?: string;
  companyDescription?: string;
}): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const email = normalizeEmail(input.email);
  assertValidSignup(email, input.password, input.name);

  const pool = getPool();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  let row: UserRow;
  try {
    const { rows } = await pool.query<UserRow>(
      `insert into users (email, password_hash, name, company_name, company_description)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [
        email,
        passwordHash,
        input.name.trim(),
        input.companyName?.trim() || null,
        input.companyDescription?.trim() || null,
      ]
    );
    row = rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new ConflictError("An account with this email already exists.");
    }
    throw err;
  }

  logger.info({ userId: row.id }, "auth: user signed up");
  return { user: toPublic(row), tokens: await issueTokens(row) };
}

export async function login(input: {
  email: string;
  password: string;
  ip: string;
}): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const email = normalizeEmail(input.email);
  assertNotLocked(email, input.ip);

  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `select * from users where email = $1`,
    [email]
  );
  const row = rows[0];

  // Same hashing cost and same error whether the account exists or not, so
  // responses don't reveal which emails are registered.
  const hash =
    row?.password_hash ??
    "$2a$12$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const ok = await bcrypt.compare(input.password, hash).catch(() => false);

  if (!row || !ok) {
    recordFailure(email, input.ip);
    throw new UnauthorizedError("Incorrect email or password.");
  }

  clearFailures(email, input.ip);
  return { user: toPublic(row), tokens: await issueTokens(row) };
}

/**
 * Rotate: the presented token is revoked and a fresh pair is issued. A
 * revoked-token replay means the token leaked (or a race) — revoke the whole
 * family for that user as a precaution.
 */
export async function refresh(token: string): Promise<{
  user: PublicUser;
  tokens: AuthTokens;
}> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(token);

  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>(`select id, user_id, expires_at, revoked_at from refresh_tokens where token_hash = $1`, [
    tokenHash,
  ]);
  const stored = rows[0];

  if (!stored) throw new UnauthorizedError("Invalid session. Please log in again.");

  if (stored.revoked_at) {
    await pool.query(
      `update refresh_tokens set revoked_at = now()
        where user_id = $1 and revoked_at is null`,
      [stored.user_id]
    );
    logger.warn({ userId: stored.user_id }, "auth: revoked refresh token replayed — revoking all sessions");
    throw new UnauthorizedError("Session invalidated. Please log in again.");
  }

  if (new Date(stored.expires_at).getTime() < Date.now()) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  const { rows: userRows } = await pool.query<UserRow>(
    `select * from users where id = $1`,
    [stored.user_id]
  );
  const user = userRows[0];
  if (!user) throw new UnauthorizedError("Account no longer exists.");

  await pool.query(`update refresh_tokens set revoked_at = now() where id = $1`, [
    stored.id,
  ]);
  // Opportunistic hygiene: drop tokens that expired more than a week ago.
  await pool
    .query(`delete from refresh_tokens where expires_at < now() - interval '7 days'`)
    .catch(() => undefined);

  return { user: toPublic(user), tokens: await issueTokens(user) };
}

export async function logout(token: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`,
    [hashRefreshToken(token)]
  );
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(`select * from users where id = $1`, [
    id,
  ]);
  return rows[0] ? toPublic(rows[0]) : null;
}

/** Company profile for the chatbot persona — null when the tenant has no user row (e.g. legacy 'default'). */
export async function getCompanyProfile(
  tenantId: string
): Promise<{ name: string | null; description: string | null } | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    company_name: string | null;
    company_description: string | null;
  }>(`select company_name, company_description from users where id::text = $1`, [
    tenantId,
  ]);
  if (!rows[0]) return null;
  return { name: rows[0].company_name, description: rows[0].company_description };
}

export async function updateProfile(
  userId: string,
  patch: { name?: string; companyName?: string | null; companyDescription?: string | null }
): Promise<PublicUser> {
  if (patch.name !== undefined && patch.name.trim().length < 2) {
    throw new BadRequestError("Please enter your name.");
  }
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `update users
        set name = coalesce($2, name),
            company_name = case when $3::boolean then $4 else company_name end,
            company_description = case when $5::boolean then $6 else company_description end
      where id = $1
      returning *`,
    [
      userId,
      patch.name?.trim() ?? null,
      patch.companyName !== undefined,
      patch.companyName?.trim() || null,
      patch.companyDescription !== undefined,
      patch.companyDescription?.trim() || null,
    ]
  );
  if (!rows[0]) throw new UnauthorizedError("Account no longer exists.");
  return toPublic(rows[0]);
}
