import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError, UnauthorizedError } from "@/utils/errors";

/**
 * Token primitives.
 *
 * Access token: a short-lived HS256 JWT carried on every API request.
 * Refresh token: a long random opaque string, stored HASHED in Postgres and
 * rotated on every use — the database never holds anything that can be
 * replayed directly if it leaks.
 */

/** Platform-level role. Org-level role lives on organization_members. */
export type UserRole = "user" | "platform_admin";

/** Role INSIDE an organization. */
export type OrgRole = "admin" | "member";

export interface AccessTokenPayload {
  /** User id — identity only. The TENANT is `org`, not this. */
  sub: string;
  email: string;
  /** Role rides in the token; a promotion takes effect on next refresh. */
  role: UserRole;
  /**
   * The workspace this user acts in — the tenant id on every table.
   * Null only for platform admins, who have no workspace of their own.
   */
  org: string | null;
  /** Their role inside that organization; null when `org` is null. */
  orgRole: OrgRole | null;
}

function secret(): string {
  if (!featureFlags.authReady || !env.JWT_SECRET) {
    throw new FeatureDisabledError("Auth (set JWT_SECRET)");
  }
  return env.JWT_SECRET;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, secret(), {
    algorithm: "HS256",
    expiresIn: `${env.JWT_ACCESS_TTL_MIN}m`,
    issuer: "vexora",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, secret(), {
      algorithms: ["HS256"],
      issuer: "vexora",
    });
    const obj = decoded as {
      sub?: unknown;
      email?: unknown;
      role?: unknown;
      org?: unknown;
      orgRole?: unknown;
    };
    const orgOk = obj.org === null || typeof obj.org === "string";
    const orgRoleOk =
      obj.orgRole === null ||
      obj.orgRole === "admin" ||
      obj.orgRole === "member";
    if (
      typeof decoded !== "object" ||
      typeof obj.sub !== "string" ||
      typeof obj.email !== "string" ||
      (obj.role !== "user" && obj.role !== "platform_admin") ||
      !orgOk ||
      !orgRoleOk
    ) {
      throw new UnauthorizedError("Invalid token");
    }
    return {
      sub: obj.sub,
      email: obj.email,
      role: obj.role,
      org: (obj.org as string | null) ?? null,
      orgRole: (obj.orgRole as OrgRole | null) ?? null,
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError(
      err instanceof jwt.TokenExpiredError ? "Token expired" : "Invalid token"
    );
  }
}

/** 256 bits of entropy, URL-safe — the value the client stores. */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** What we store: SHA-256 of the token. Deterministic lookup, useless if leaked. */
export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Google OAuth state: binds a /connect click to the signed-in user's
// WORKSPACE, so the callback (which arrives from Google with no
// Authorization header) can't be forged to attach a calendar to another
// organization.
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(organizationId: string): string {
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  const body = `${organizationId}.${exp}`;
  const sig = crypto
    .createHmac("sha256", secret())
    .update(body)
    .digest("base64url");
  return Buffer.from(`${body}.${sig}`).toString("base64url");
}

export function verifyOAuthState(state: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    throw new UnauthorizedError("Invalid OAuth state");
  }
  const parts = decoded.split(".");
  if (parts.length !== 3) throw new UnauthorizedError("Invalid OAuth state");
  const [organizationId, expStr, sig] = parts as [string, string, string];

  const expected = crypto
    .createHmac("sha256", secret())
    .update(`${organizationId}.${expStr}`)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new UnauthorizedError("Invalid OAuth state");
  }
  if (Number(expStr) < Date.now()) {
    throw new UnauthorizedError("OAuth state expired — restart the connect flow");
  }
  return organizationId;
}
