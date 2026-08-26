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

export type UserRole = "user" | "admin";

export interface AccessTokenPayload {
  /** User id — doubles as the tenant id everywhere. */
  sub: string;
  email: string;
  /** Role rides in the token; a promotion takes effect on next refresh. */
  role: UserRole;
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
    const obj = decoded as { sub?: unknown; email?: unknown; role?: unknown };
    if (
      typeof decoded !== "object" ||
      typeof obj.sub !== "string" ||
      typeof obj.email !== "string" ||
      (obj.role !== "user" && obj.role !== "admin")
    ) {
      throw new UnauthorizedError("Invalid token");
    }
    return { sub: obj.sub, email: obj.email, role: obj.role };
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
// Google OAuth state: binds a /connect click to the signed-in user so the
// callback (which arrives from Google with no Authorization header) can't be
// forged to attach a calendar to someone else's account.
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(userId: string): string {
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  const body = `${userId}.${exp}`;
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
  const [userId, expStr, sig] = parts as [string, string, string];

  const expected = crypto
    .createHmac("sha256", secret())
    .update(`${userId}.${expStr}`)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new UnauthorizedError("Invalid OAuth state");
  }
  if (Number(expStr) < Date.now()) {
    throw new UnauthorizedError("OAuth state expired — restart the connect flow");
  }
  return userId;
}
