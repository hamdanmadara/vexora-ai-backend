import { getPool } from "@/db/pool";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import {
  invalidateOrganizationStatus,
  listMembers,
  toPublicOrganization,
  type OrganizationMember,
  type OrganizationRow,
  type OrgStatus,
  type PublicOrganization,
} from "./organization.service";

/**
 * Read/administration of EVERY organization — Vexora staff only. Guarded by
 * `requirePlatformAdmin`; nothing here is tenant-scoped, which is exactly why
 * it must never be mounted anywhere a customer can reach.
 */

export interface OrganizationSummary extends PublicOrganization {
  /** Rough workspace activity, so we can see who is actually using it. */
  documentCount: number;
  conversationCount: number;
}

export interface OrganizationDetail extends OrganizationSummary {
  members: OrganizationMember[];
}

/** One query, so the list stays fast as the number of orgs grows. */
export async function listOrganizations(): Promise<OrganizationSummary[]> {
  const pool = getPool();
  const { rows } = await pool.query<
    OrganizationRow & {
      seats_used: number;
      document_count: number;
      conversation_count: number;
    }
  >(
    `select o.*,
            (select count(*)::int from organization_members m
              where m.organization_id = o.id) as seats_used,
            (select count(*)::int from documents d
              where d.tenant_id = o.id::text) as document_count,
            (select count(*)::int from leads l
              where l.tenant_id = o.id::text) as conversation_count
       from organizations o
      order by o.created_at desc`
  );

  return rows.map((r) => ({
    ...toPublicOrganization(r, r.seats_used),
    documentCount: r.document_count,
    conversationCount: r.conversation_count,
  }));
}

export async function getOrganizationDetail(
  organizationId: string
): Promise<OrganizationDetail> {
  const pool = getPool();
  const { rows } = await pool.query<
    OrganizationRow & {
      seats_used: number;
      document_count: number;
      conversation_count: number;
    }
  >(
    `select o.*,
            (select count(*)::int from organization_members m
              where m.organization_id = o.id) as seats_used,
            (select count(*)::int from documents d
              where d.tenant_id = o.id::text) as document_count,
            (select count(*)::int from leads l
              where l.tenant_id = o.id::text) as conversation_count
       from organizations o
      where o.id = $1`,
    [organizationId]
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Organization not found");

  return {
    ...toPublicOrganization(row, row.seats_used),
    documentCount: row.document_count,
    conversationCount: row.conversation_count,
    members: await listMembers(organizationId),
  };
}

/**
 * Set the seat limit (what the client has paid for) and/or suspend them.
 * Lowering the limit below the seats already in use is refused — we never
 * silently orphan someone's colleagues.
 */
export async function updateOrganizationAsPlatformAdmin(
  organizationId: string,
  patch: { seatLimit?: number; status?: OrgStatus }
): Promise<OrganizationDetail> {
  const pool = getPool();

  if (patch.seatLimit !== undefined) {
    if (!Number.isInteger(patch.seatLimit) || patch.seatLimit < 1) {
      throw new BadRequestError("Seat limit must be a whole number of 1 or more.");
    }
    const { rows } = await pool.query<{ count: number }>(
      `select count(*)::int as count from organization_members where organization_id = $1`,
      [organizationId]
    );
    const seatsUsed = rows[0]?.count ?? 0;
    if (patch.seatLimit < seatsUsed) {
      throw new BadRequestError(
        `This organization already has ${seatsUsed} users. Remove users before lowering the limit to ${patch.seatLimit}.`
      );
    }
  }

  const { rowCount } = await pool.query(
    `update organizations
        set seat_limit = coalesce($2, seat_limit),
            status = coalesce($3, status)
      where id = $1`,
    [organizationId, patch.seatLimit ?? null, patch.status ?? null]
  );
  if (!rowCount) throw new NotFoundError("Organization not found");

  // A suspension must bite immediately, not when the status cache expires.
  invalidateOrganizationStatus(organizationId);
  logger.info({ organizationId, ...patch }, "organization updated by platform admin");

  return getOrganizationDetail(organizationId);
}
