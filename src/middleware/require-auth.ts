import type { NextFunction, Request, Response } from "express";
import { featureFlags } from "@/config/env";
import { FeatureDisabledError, UnauthorizedError } from "@/utils/errors";
import {
  verifyAccessToken,
  type OrgRole,
  type UserRole,
} from "@/services/auth/token.service";
import { getLiveMembership } from "@/services/organization/organization.service";

/**
 * Authenticated request context.
 *
 * `userId` is IDENTITY (who is acting). `organizationId` is TENANCY (whose
 * workspace the data belongs to) and is what every tenant-scoped query uses —
 * read it through `tenantOf(req)` so the distinction stays explicit.
 */
export interface AuthContext {
  userId: string;
  email: string;
  /** Platform-level: 'platform_admin' is Vexora staff. */
  role: UserRole;
  /** The workspace. Null only for platform admins, who have no workspace. */
  organizationId: string | null;
  /** Role inside that workspace; null when organizationId is null. */
  orgRole: OrgRole | null;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!featureFlags.authReady) {
    next(new FeatureDisabledError("Auth (set JWT_SECRET)"));
    return;
  }

  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    next(new UnauthorizedError("Missing bearer token"));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      organizationId: payload.org,
      orgRole: payload.orgRole,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** The auth context, guaranteed by requireAuth. */
export function authOf(req: Request): AuthContext {
  if (!req.auth) {
    // Programming error — a handler forgot to mount requireAuth.
    throw new UnauthorizedError("Not authenticated");
  }
  return req.auth;
}

/**
 * The workspace (tenant) this request acts on. Every tenant-scoped query goes
 * through here rather than reading userId, so "identity" and "tenancy" can
 * never be confused again.
 */
export function tenantOf(req: Request): string {
  const { organizationId } = authOf(req);
  if (!organizationId) {
    throw new UnauthorizedError(
      "This account has no workspace. Platform admins manage organizations instead."
    );
  }
  return organizationId;
}

/** Vexora staff only — the platform admin area. */
export function requirePlatformAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.auth?.role !== "platform_admin") {
    next(new UnauthorizedError("Platform admin access required"));
    return;
  }
  next();
}

/**
 * Admin of their own organization — integration keys and user management.
 * B2C users are admins of their personal org, so they pass automatically:
 * no separate B2C branch is needed anywhere.
 *
 * The role is re-read from the database (briefly cached) rather than taken
 * from the token: a demoted admin would otherwise keep admin powers until
 * their access token expired.
 */
export async function requireOrgAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const denied = new UnauthorizedError(
    "Only an organization admin can do this. Ask your admin for access."
  );

  if (!req.auth?.organizationId) {
    next(denied);
    return;
  }

  try {
    const membership = await getLiveMembership(req.auth.userId);
    if (
      !membership ||
      membership.organizationId !== req.auth.organizationId ||
      membership.orgRole !== "admin"
    ) {
      next(denied);
      return;
    }
    // Keep the request context truthful for anything downstream.
    req.auth.orgRole = membership.orgRole;
    next();
  } catch (err) {
    next(err);
  }
}
