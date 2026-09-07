import type { PoolClient } from "pg";
import { getPool, withTransaction } from "@/db/pool";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import { assertValidPassword, hashPassword } from "@/services/auth/password";
import type { OrgRole } from "@/services/auth/token.service";

/**
 * Organizations are the TENANT: every document, lead, integration, calendar
 * and analytics row belongs to one. A B2C user simply gets a `personal` org
 * of their own, so there is a single code path for both audiences.
 */

export type OrgType = "business" | "personal";
export type OrgStatus = "active" | "suspended";

export interface OrganizationRow {
  id: string;
  name: string;
  type: OrgType;
  status: OrgStatus;
  seat_limit: number;
  company_name: string | null;
  company_description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicOrganization {
  id: string;
  name: string;
  type: OrgType;
  status: OrgStatus;
  seatLimit: number;
  seatsUsed: number;
  companyName: string | null;
  companyDescription: string | null;
  createdAt: string;
}

export interface OrganizationMember {
  id: string;
  email: string;
  name: string;
  orgRole: OrgRole;
  createdAt: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertValidEmail(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestError("Please enter a valid email address.");
  }
}

function assertValidName(name: string): void {
  if (name.trim().length < 2) {
    throw new BadRequestError("Please enter a name (at least 2 characters).");
  }
}

function seatsFullMessage(limit: number): string {
  const seats = limit === 1 ? "1 seat" : `${limit} seats`;
  return `Your plan includes ${seats} and all of them are in use. Contact us to add more.`;
}

export function toPublicOrganization(
  row: OrganizationRow,
  seatsUsed: number
): PublicOrganization {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    seatLimit: row.seat_limit,
    seatsUsed,
    companyName: row.company_name,
    companyDescription: row.company_description,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The org a user belongs to, plus their role in it. Null for platform admins. */
export async function getMembershipForUser(
  userId: string
): Promise<{ organizationId: string; orgRole: OrgRole } | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ organization_id: string; role: OrgRole }>(
    `select organization_id, role from organization_members where user_id = $1`,
    [userId]
  );
  const row = rows[0];
  return row ? { organizationId: row.organization_id, orgRole: row.role } : null;
}

const ROLE_TTL_MS = 15_000;
const roleCache = new Map<
  string,
  { membership: { organizationId: string; orgRole: OrgRole } | null; at: number }
>();

/**
 * The membership as it is RIGHT NOW, briefly cached.
 *
 * The JWT carries orgRole for convenience, but a demoted admin would keep
 * admin powers until their token expired. Permission checks therefore read
 * through here instead of trusting the claim.
 */
export async function getLiveMembership(
  userId: string
): Promise<{ organizationId: string; orgRole: OrgRole } | null> {
  const cached = roleCache.get(userId);
  if (cached && Date.now() - cached.at < ROLE_TTL_MS) return cached.membership;

  const membership = await getMembershipForUser(userId);
  if (roleCache.size > 10_000) roleCache.clear();
  roleCache.set(userId, { membership, at: Date.now() });
  return membership;
}

/** Drop a cached role immediately after changing it. */
export function invalidateMembership(userId: string): void {
  roleCache.delete(userId);
}

export async function countSeatsUsed(organizationId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count from organization_members where organization_id = $1`,
    [organizationId]
  );
  return rows[0]?.count ?? 0;
}

export async function getOrganizationRow(
  organizationId: string
): Promise<OrganizationRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<OrganizationRow>(
    `select * from organizations where id = $1`,
    [organizationId]
  );
  return rows[0] ?? null;
}

export async function getOrganization(
  organizationId: string
): Promise<PublicOrganization> {
  const row = await getOrganizationRow(organizationId);
  if (!row) throw new NotFoundError("Organization not found");
  return toPublicOrganization(row, await countSeatsUsed(organizationId));
}

/**
 * Status check used on every authenticated request. Cached briefly so a
 * suspension takes effect within seconds (rather than waiting out the access
 * token's lifetime) without adding a DB round-trip to every request.
 */
const STATUS_TTL_MS = 30_000;
const statusCache = new Map<string, { status: OrgStatus; at: number }>();

export async function getOrganizationStatus(
  organizationId: string
): Promise<OrgStatus | null> {
  const cached = statusCache.get(organizationId);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;

  const pool = getPool();
  const { rows } = await pool.query<{ status: OrgStatus }>(
    `select status from organizations where id = $1`,
    [organizationId]
  );
  const status = rows[0]?.status ?? null;
  if (status) {
    if (statusCache.size > 10_000) statusCache.clear();
    statusCache.set(organizationId, { status, at: Date.now() });
  }
  return status;
}

/** Drop a cached status immediately after changing it. */
export function invalidateOrganizationStatus(organizationId: string): void {
  statusCache.delete(organizationId);
}

// ---------------------------------------------------------------------------
// Creation (signup)
// ---------------------------------------------------------------------------

/**
 * Create an organization together with its first user and their admin
 * membership, atomically. Used by BOTH signup paths — a personal account is
 * just a `personal` org with one seat.
 */
export async function createOrganizationWithAdmin(input: {
  organizationName: string;
  type: OrgType;
  name: string;
  email: string;
  password: string;
  companyName?: string | null;
  companyDescription?: string | null;
}): Promise<{ organization: OrganizationRow; userId: string }> {
  const email = normalizeEmail(input.email);
  assertValidEmail(email);
  assertValidName(input.name);
  assertValidPassword(input.password);
  if (input.organizationName.trim().length < 2) {
    throw new BadRequestError("Please enter an organization name.");
  }

  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (client: PoolClient) => {
    let userId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into users (email, password_hash, name) values ($1, $2, $3) returning id`,
        [email, passwordHash, input.name.trim()]
      );
      userId = rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError("An account with this email already exists.");
      }
      throw err;
    }

    const { rows: orgRows } = await client.query<OrganizationRow>(
      `insert into organizations (name, type, seat_limit, company_name, company_description)
       values ($1, $2, 1, $3, $4)
       returning *`,
      [
        input.organizationName.trim(),
        input.type,
        input.companyName?.trim() || null,
        input.companyDescription?.trim() || null,
      ]
    );
    const organization = orgRows[0]!;

    await client.query(
      `insert into organization_members (organization_id, user_id, role)
       values ($1, $2, 'admin')`,
      [organization.id, userId]
    );

    logger.info(
      { organizationId: organization.id, type: input.type },
      "organization created"
    );
    return { organization, userId };
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function updateOrganization(
  organizationId: string,
  patch: {
    name?: string;
    companyName?: string | null;
    companyDescription?: string | null;
  }
): Promise<PublicOrganization> {
  if (patch.name !== undefined && patch.name.trim().length < 2) {
    throw new BadRequestError("Please enter an organization name.");
  }
  const pool = getPool();
  const { rows } = await pool.query<OrganizationRow>(
    `update organizations
        set name = coalesce($2, name),
            company_name = case when $3::boolean then $4 else company_name end,
            company_description = case when $5::boolean then $6 else company_description end
      where id = $1
      returning *`,
    [
      organizationId,
      patch.name?.trim() ?? null,
      patch.companyName !== undefined,
      patch.companyName?.trim() || null,
      patch.companyDescription !== undefined,
      patch.companyDescription?.trim() || null,
    ]
  );
  if (!rows[0]) throw new NotFoundError("Organization not found");
  return toPublicOrganization(rows[0], await countSeatsUsed(organizationId));
}

/**
 * The chatbot's identity for a workspace, used to build the agent persona.
 * Lives on the ORGANIZATION now (it used to be read off `users`).
 */
export async function getCompanyProfile(
  organizationId: string
): Promise<{ name: string | null; description: string | null } | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    company_name: string | null;
    company_description: string | null;
  }>(
    `select company_name, company_description from organizations where id::text = $1`,
    [organizationId]
  );
  if (!rows[0]) return null;
  return {
    name: rows[0].company_name,
    description: rows[0].company_description,
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listMembers(
  organizationId: string
): Promise<OrganizationMember[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    email: string;
    name: string;
    role: OrgRole;
    created_at: string;
  }>(
    `select u.id, u.email, u.name, m.role, u.created_at
       from organization_members m
       join users u on u.id = m.user_id
      where m.organization_id = $1
      order by m.role asc, u.created_at asc`,
    [organizationId]
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    orgRole: r.role,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Add a user to an organization. There are no invite emails by design: the
 * admin sets the password and hands over the credentials themselves.
 */
export async function addMember(
  organizationId: string,
  input: { name: string; email: string; password: string; orgRole?: OrgRole }
): Promise<OrganizationMember> {
  const email = normalizeEmail(input.email);
  assertValidEmail(email);
  assertValidName(input.name);
  assertValidPassword(input.password);

  const org = await getOrganizationRow(organizationId);
  if (!org) throw new NotFoundError("Organization not found");

  const passwordHash = await hashPassword(input.password);
  const orgRole: OrgRole = input.orgRole === "admin" ? "admin" : "member";

  return withTransaction(async (client: PoolClient) => {
    // Lock the ORGANIZATION row (not the member rows — Postgres refuses FOR
    // UPDATE alongside an aggregate). Serialising on the parent means two
    // concurrent adds cannot both read "one seat left" and both take it, and
    // it re-reads seat_limit inside the transaction in case a platform admin
    // changed it a moment ago.
    const { rows: lockRows } = await client.query<{ seat_limit: number }>(
      `select seat_limit from organizations where id = $1 for update`,
      [organizationId]
    );
    const seatLimit = lockRows[0]?.seat_limit;
    if (seatLimit === undefined) throw new NotFoundError("Organization not found");

    const { rows: seatRows } = await client.query<{ count: number }>(
      `select count(*)::int as count from organization_members where organization_id = $1`,
      [organizationId]
    );
    if ((seatRows[0]?.count ?? 0) >= seatLimit) {
      throw new ConflictError(seatsFullMessage(seatLimit));
    }

    let user: { id: string; created_at: string };
    try {
      const { rows } = await client.query<{ id: string; created_at: string }>(
        `insert into users (email, password_hash, name) values ($1, $2, $3)
         returning id, created_at`,
        [email, passwordHash, input.name.trim()]
      );
      user = rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError("An account with this email already exists.");
      }
      throw err;
    }

    await client.query(
      `insert into organization_members (organization_id, user_id, role)
       values ($1, $2, $3)`,
      [organizationId, user.id, orgRole]
    );

    logger.info({ organizationId, userId: user.id }, "organization member added");
    return {
      id: user.id,
      email,
      name: input.name.trim(),
      orgRole,
      createdAt: new Date(user.created_at).toISOString(),
    };
  });
}

/** Ownership check: the target user must belong to THIS organization. */
async function assertMemberOfOrg(
  organizationId: string,
  userId: string
): Promise<OrgRole> {
  const pool = getPool();
  const { rows } = await pool.query<{ role: OrgRole }>(
    `select role from organization_members where organization_id = $1 and user_id = $2`,
    [organizationId, userId]
  );
  // 404 rather than 403: never confirm that a user exists in another org.
  if (!rows[0]) throw new NotFoundError("User not found");
  return rows[0].role;
}

async function countAdmins(organizationId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count from organization_members
      where organization_id = $1 and role = 'admin'`,
    [organizationId]
  );
  return rows[0]?.count ?? 0;
}

export async function updateMember(
  organizationId: string,
  userId: string,
  patch: { name?: string; password?: string; orgRole?: OrgRole }
): Promise<OrganizationMember> {
  const currentRole = await assertMemberOfOrg(organizationId, userId);

  if (patch.name !== undefined) assertValidName(patch.name);
  if (patch.password !== undefined) assertValidPassword(patch.password);

  // An organization must always keep at least one admin.
  if (
    patch.orgRole === "member" &&
    currentRole === "admin" &&
    (await countAdmins(organizationId)) <= 1
  ) {
    throw new ConflictError(
      "This is the only admin. Promote someone else before changing this role."
    );
  }

  const passwordHash =
    patch.password !== undefined ? await hashPassword(patch.password) : null;

  return withTransaction(async (client: PoolClient) => {
    const { rows } = await client.query<{
      id: string;
      email: string;
      name: string;
      created_at: string;
    }>(
      `update users
          set name = coalesce($2, name),
              password_hash = coalesce($3, password_hash)
        where id = $1
        returning id, email, name, created_at`,
      [userId, patch.name?.trim() ?? null, passwordHash]
    );
    const user = rows[0];
    if (!user) throw new NotFoundError("User not found");

    let role = currentRole;
    if (patch.orgRole && patch.orgRole !== currentRole) {
      await client.query(
        `update organization_members set role = $3
          where organization_id = $1 and user_id = $2`,
        [organizationId, userId, patch.orgRole]
      );
      role = patch.orgRole;
      invalidateMembership(userId);
    }

    // A password change must not leave old sessions alive.
    if (passwordHash) {
      await client.query(
        `update refresh_tokens set revoked_at = now()
          where user_id = $1 and revoked_at is null`,
        [userId]
      );
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      orgRole: role,
      createdAt: new Date(user.created_at).toISOString(),
    };
  });
}

export async function removeMember(
  organizationId: string,
  userId: string,
  actingUserId: string
): Promise<void> {
  if (userId === actingUserId) {
    throw new UnauthorizedError("You cannot remove your own account.");
  }
  const role = await assertMemberOfOrg(organizationId, userId);
  if (role === "admin" && (await countAdmins(organizationId)) <= 1) {
    throw new ConflictError(
      "This is the only admin. Promote someone else before removing them."
    );
  }

  // Deleting the user cascades to organization_members and refresh_tokens,
  // so their sessions die with the account.
  const pool = getPool();
  await pool.query(`delete from users where id = $1`, [userId]);
  invalidateMembership(userId);
  logger.info({ organizationId, userId }, "organization member removed");
}
