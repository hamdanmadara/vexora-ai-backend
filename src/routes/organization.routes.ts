import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { requireOrgAdmin } from "@/middleware/require-auth";
import {
  deleteMember,
  getMembers,
  getMyOrganization,
  patchMember,
  patchMyOrganization,
  postMember,
} from "@/controllers/organization.controller";

export const organizationRouter = Router();

// Every member may see their workspace and who is in it.
organizationRouter.get("/", asyncHandler(getMyOrganization));
organizationRouter.get("/members", asyncHandler(getMembers));

// Changing the workspace or its people is admin-only.
organizationRouter.patch("/", requireOrgAdmin, asyncHandler(patchMyOrganization));
organizationRouter.post("/members", requireOrgAdmin, asyncHandler(postMember));
organizationRouter.patch("/members/:id", requireOrgAdmin, asyncHandler(patchMember));
organizationRouter.delete("/members/:id", requireOrgAdmin, asyncHandler(deleteMember));
