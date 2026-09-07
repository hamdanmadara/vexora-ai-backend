import type { Request, Response } from "express";
import { z } from "zod";
import { BadRequestError } from "@/utils/errors";
import { authOf, tenantOf } from "@/middleware/require-auth";
import {
  addMember,
  getOrganization,
  listMembers,
  removeMember,
  updateMember,
  updateOrganization,
} from "@/services/organization/organization.service";

const OrgPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  companyName: z.string().max(200).nullable().optional(),
  companyDescription: z.string().max(2000).nullable().optional(),
});

const AddMemberSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().min(3).max(320),
  // The admin sets this and passes it on themselves — no invite emails.
  password: z.string().min(1).max(200),
  orgRole: z.enum(["admin", "member"]).optional(),
});

const UpdateMemberSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(1).max(200).optional(),
  orgRole: z.enum(["admin", "member"]).optional(),
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

function memberId(req: Request<{ id: string }>): string {
  const id = String(req.params.id ?? "");
  if (!id) throw new BadRequestError("Missing user id");
  return id;
}

/** GET /api/organization — the caller's workspace, with seat usage. */
export async function getMyOrganization(
  req: Request,
  res: Response
): Promise<void> {
  const organization = await getOrganization(tenantOf(req));
  res.json({ organization });
}

/** PATCH /api/organization — name + the company profile the bot presents. */
export async function patchMyOrganization(
  req: Request,
  res: Response
): Promise<void> {
  const body = parse(OrgPatchSchema, req.body);
  const organization = await updateOrganization(tenantOf(req), body);
  res.json({ organization });
}

/** GET /api/organization/members — visible to every member of the org. */
export async function getMembers(req: Request, res: Response): Promise<void> {
  const members = await listMembers(tenantOf(req));
  res.json({ members });
}

/** POST /api/organization/members — admin only; enforces the seat limit. */
export async function postMember(req: Request, res: Response): Promise<void> {
  const body = parse(AddMemberSchema, req.body);
  const member = await addMember(tenantOf(req), body);
  res.status(201).json({ member });
}

/** PATCH /api/organization/members/:id — rename, change role, reset password. */
export async function patchMember(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  const body = parse(UpdateMemberSchema, req.body);
  const member = await updateMember(tenantOf(req), memberId(req), body);
  res.json({ member });
}

/** DELETE /api/organization/members/:id — returns JSON (the client parses a body). */
export async function deleteMember(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  await removeMember(tenantOf(req), memberId(req), userId);
  res.json({ ok: true });
}
