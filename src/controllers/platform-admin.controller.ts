import type { Request, Response } from "express";
import { z } from "zod";
import { BadRequestError } from "@/utils/errors";
import {
  getOrganizationDetail,
  listOrganizations,
  updateOrganizationAsPlatformAdmin,
} from "@/services/organization/platform-admin.service";

const OrgAdminPatchSchema = z
  .object({
    seatLimit: z.number().int().min(1).max(10_000).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .refine((v) => v.seatLimit !== undefined || v.status !== undefined, {
    message: "Provide seatLimit and/or status",
  });

// Generic over the SCHEMA, not its output type: this keeps inference correct
// for schemas that use .default() or .refine(), where input and output differ.
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new BadRequestError(
      first
        ? `${first.path.join(".") || "body"}: ${first.message}`
        : "Invalid request body"
    );
  }
  return result.data;
}

function orgId(req: Request<{ id: string }>): string {
  const id = String(req.params.id ?? "");
  if (!id) throw new BadRequestError("Missing organization id");
  return id;
}

/** GET /api/admin/organizations — every workspace on the platform. */
export async function getOrganizations(
  _req: Request,
  res: Response
): Promise<void> {
  const organizations = await listOrganizations();
  res.json({ organizations });
}

/** GET /api/admin/organizations/:id — one workspace with its members. */
export async function getOrganizationById(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  const organization = await getOrganizationDetail(orgId(req));
  res.json({ organization });
}

/** PATCH /api/admin/organizations/:id — seat limit and suspend/reactivate. */
export async function patchOrganization(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  const body = parse(OrgAdminPatchSchema, req.body);
  const organization = await updateOrganizationAsPlatformAdmin(orgId(req), body);
  res.json({ organization });
}
