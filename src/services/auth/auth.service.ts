import { getPool } from "@/db/pool";
import { env } from "@/config/env";
import { BadRequestError, UnauthorizedError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import {
  createOrganizationWithAdmin,
  getMembershipForUser,
  getOrganization,
  normalizeEmail,
  type OrgType,
  type PublicOrganization,
} from "@/services/organization/organization.service";
import {
  assertValidPassword,
  comparePassword,
  DUMMY_HASH,
  hashPassword,
} from "./password";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type OrgRole,
  type UserRole,
} from "./token.service";

export type { UserRole };

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

/**
 * The shape that ever leaves the API — password hash stripped.
 *
 * The company profile is NOT here: it belongs to the organization (the
 * chatbot represents a company, not a person), so clients read it from
 * `organization`.
 */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  /** Platform-level role. */
  role: UserRole;
  /** Role inside their organization; null for platform admins. */
  orgRole: OrgRole | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires — lets the client refresh early. */
  expiresIn: number;
}

export interface AuthResult {
  user: PublicUser;
  /** The workspace they act in. Null for platform admins (they have none). */
  organization: PublicOrganization | null;
  tokens: AuthTokens;
}

function toPublic(row: UserRow, orgRole: OrgRole | null): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    orgRole,
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
// Session assembly
// ---------------------------------------------------------------------------

/**
 * Build the full session for a user: their membership decides the tenant
 * baked into the access token, so every later request carries its workspace.
 */
async function buildSession(user: UserRow): Promise<AuthResult> {
  const membership = await getMembershipForUser(user.id);
  const organization = membership
    ? await getOrganization(membership.organizationId)
    : null;

  if (organization?.status === "suspended") {
    throw new UnauthorizedError(
      "This workspace is suspended. Please contact support."
    );
  }

  const pool = getPool();
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);

  await pool.query(
    `insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)`,
    [user.id, hashRefreshToken(refreshToken), expiresAt]
  );

  return {
    user: toPublic(user, membership?.orgRole ?? null),
    organization,
    tokens: {
      accessToken: signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        org: membership?.organizationId ?? null,
        orgRole: membership?.orgRole ?? null,
      }),
      refreshToken,
      expiresIn: env.JWT_ACCESS_TTL_MIN * 60,
    },
  };
}

async function getUserRow(userId: string): Promise<UserRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `select * from users where id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignupInput {
  /** 'organization' = a company with seats; 'personal' = a solo workspace. */
  accountType: OrgType;
  email: string;
  password: string;
  name: string;
  /** Required for accountType='business'; defaults to the person's name otherwise. */
  organizationName?: string;
  companyName?: string;
  companyDescription?: string;
}

/**
 * Signup always creates an ORGANIZATION plus its first admin. A personal
 * account is simply a `personal` org with one seat, which keeps a single
 * code path for B2B and B2C everywhere downstream.
 *
 * Signup can never create a platform admin — the column defaults to 'user'
 * and no input maps to it. Staff are promoted manually in SQL.
 */
export async function signup(input: SignupInput): Promise<AuthResult> {
  const type: OrgType =
    input.accountType === "business" ? "business" : "personal";

  if (type === "business" && !input.organizationName?.trim()) {
    throw new BadRequestError("Please enter your organization name.");
  }

  const organizationName =
    type === "business"
      ? input.organizationName!.trim()
      : input.companyName?.trim() || `${input.name.trim()}'s workspace`;

  const { userId } = await createOrganizationWithAdmin({
    organizationName,
    type,
    name: input.name,
    email: input.email,
    password: input.password,
    // For a business the org name doubles as the company the bot represents,
    // unless a distinct one was supplied.
    companyName:
      input.companyName?.trim() || (type === "business" ? organizationName : null),
    companyDescription: input.companyDescription ?? null,
  });

  const user = await getUserRow(userId);
  if (!user) throw new UnauthorizedError("Account creation failed.");

  logger.info({ userId, type }, "auth: user signed up");
  return buildSession(user);
}

export async function login(input: {
  email: string;
  password: string;
  ip: string;
}): Promise<AuthResult> {
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
  const ok = await comparePassword(input.password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok) {
    recordFailure(email, input.ip);
    throw new UnauthorizedError("Incorrect email or password.");
  }

  clearFailures(email, input.ip);
  return buildSession(row);
}

/**
 * Rotate: the presented token is revoked and a fresh pair is issued. A
 * revoked-token replay means the token leaked (or a race) — revoke the whole
 * family for that user as a precaution.
 *
 * Refresh is also where role, seat and suspension changes take effect.
 */
export async function refresh(token: string): Promise<AuthResult> {
  const pool = getPool();
  const tokenHash = hashRefreshToken(token);

  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `select id, user_id, expires_at, revoked_at from refresh_tokens where token_hash = $1`,
    [tokenHash]
  );
  const stored = rows[0];

  if (!stored) throw new UnauthorizedError("Invalid session. Please log in again.");

  if (stored.revoked_at) {
    await pool.query(
      `update refresh_tokens set revoked_at = now()
        where user_id = $1 and revoked_at is null`,
      [stored.user_id]
    );
    logger.warn(
      { userId: stored.user_id },
      "auth: revoked refresh token replayed — revoking all sessions"
    );
    throw new UnauthorizedError("Session invalidated. Please log in again.");
  }

  if (new Date(stored.expires_at).getTime() < Date.now()) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  const user = await getUserRow(stored.user_id);
  if (!user) throw new UnauthorizedError("Account no longer exists.");

  await pool.query(`update refresh_tokens set revoked_at = now() where id = $1`, [
    stored.id,
  ]);
  // Opportunistic hygiene: drop tokens that expired more than a week ago.
  await pool
    .query(`delete from refresh_tokens where expires_at < now() - interval '7 days'`)
    .catch(() => undefined);

  return buildSession(user);
}

export async function logout(token: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`,
    [hashRefreshToken(token)]
  );
}

/** Current user plus their workspace — what /api/auth/me returns. */
export async function getSessionUser(
  userId: string
): Promise<{ user: PublicUser; organization: PublicOrganization | null } | null> {
  const user = await getUserRow(userId);
  if (!user) return null;
  const membership = await getMembershipForUser(userId);
  return {
    user: toPublic(user, membership?.orgRole ?? null),
    organization: membership
      ? await getOrganization(membership.organizationId)
      : null,
  };
}

/**
 * Self-service password change — available to every account, whatever its
 * role: members, organization admins and platform admins alike.
 *
 * The current password is required so an unattended, already-signed-in
 * browser cannot be used to take the account over. Every existing session is
 * then revoked and a fresh pair handed back to the caller, so changing a
 * password really does sign out every other device.
 */
export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string }
): Promise<AuthResult> {
  const user = await getUserRow(userId);
  if (!user) throw new UnauthorizedError("Account no longer exists.");

  if (!(await comparePassword(input.currentPassword, user.password_hash))) {
    throw new BadRequestError("Your current password is incorrect.");
  }

  assertValidPassword(input.newPassword);
  if (await comparePassword(input.newPassword, user.password_hash)) {
    throw new BadRequestError(
      "Your new password must be different from the current one."
    );
  }

  const passwordHash = await hashPassword(input.newPassword);
  const pool = getPool();
  await pool.query(`update users set password_hash = $2 where id = $1`, [
    userId,
    passwordHash,
  ]);
  // Revoke first, then issue: the caller gets the only surviving session.
  await pool.query(
    `update refresh_tokens set revoked_at = now()
      where user_id = $1 and revoked_at is null`,
    [userId]
  );

  return buildSession({ ...user, password_hash: passwordHash });
}

/** Personal details only. The company profile lives on the organization. */
export async function updateProfile(
  userId: string,
  patch: { name?: string }
): Promise<PublicUser> {
  if (patch.name !== undefined && patch.name.trim().length < 2) {
    throw new BadRequestError("Please enter your name.");
  }
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `update users set name = coalesce($2, name) where id = $1 returning *`,
    [userId, patch.name?.trim() ?? null]
  );
  if (!rows[0]) throw new UnauthorizedError("Account no longer exists.");
  const membership = await getMembershipForUser(userId);
  return toPublic(rows[0], membership?.orgRole ?? null);
}
