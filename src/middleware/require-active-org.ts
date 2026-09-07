import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError } from "@/utils/errors";
import { getOrganizationStatus } from "@/services/organization/organization.service";

/**
 * Blocks every member of a suspended organization.
 *
 * Suspension has to bite immediately — waiting for the access token to expire
 * would leave an unpaid workspace fully usable for up to an hour. The status
 * lookup is cached for ~30s inside the service, so this costs at most one
 * small query per org per half-minute rather than one per request.
 *
 * Mount AFTER requireAuth on workspace routers. Platform admins have no
 * organization, so they pass straight through.
 */
export async function requireActiveOrg(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const organizationId = req.auth?.organizationId;
  if (!organizationId) {
    next();
    return;
  }

  try {
    const status = await getOrganizationStatus(organizationId);
    if (status === "suspended") {
      next(
        new UnauthorizedError(
          "This workspace is suspended. Please contact support."
        )
      );
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
