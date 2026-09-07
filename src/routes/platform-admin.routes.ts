import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import {
  getOrganizationById,
  getOrganizations,
  patchOrganization,
} from "@/controllers/platform-admin.controller";

/**
 * Vexora staff only. Nothing here is tenant-scoped, so the router is mounted
 * behind requirePlatformAdmin in routes/index.ts.
 */
export const platformAdminRouter = Router();

platformAdminRouter.get("/organizations", asyncHandler(getOrganizations));
platformAdminRouter.get("/organizations/:id", asyncHandler(getOrganizationById));
platformAdminRouter.patch("/organizations/:id", asyncHandler(patchOrganization));
