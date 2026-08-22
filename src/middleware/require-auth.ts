import type { NextFunction, Request, Response } from "express";
import { featureFlags } from "@/config/env";
import { FeatureDisabledError, UnauthorizedError } from "@/utils/errors";
import { verifyAccessToken, type UserRole } from "@/services/auth/token.service";

/**
 * Authenticated request context. The user's id doubles as the tenant id on
 * every table, so downstream code reads req.auth.userId and nothing else.
 */
export interface AuthContext {
  userId: string;
  email: string;
  role: UserRole;
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
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Admin-mode gate: mount AFTER requireAuth on platform-operator routes.
 * (No admin routes exist yet — this is ready for the admin phase.)
 */
export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.auth?.role !== "admin") {
    next(new UnauthorizedError("Admin access required"));
    return;
  }
  next();
}

/** Convenience for handlers: the auth context, guaranteed by requireAuth. */
export function authOf(req: Request): AuthContext {
  if (!req.auth) {
    // Programming error — a handler forgot to mount requireAuth.
    throw new UnauthorizedError("Not authenticated");
  }
  return req.auth;
}
