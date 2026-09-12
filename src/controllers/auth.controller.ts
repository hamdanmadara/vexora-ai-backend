import type { Request, Response } from "express";
import { z } from "zod";
import { BadRequestError } from "@/utils/errors";
import { authOf } from "@/middleware/require-auth";
import {
  changePassword,
  getSessionUser,
  login,
  logout,
  refresh,
  signup,
  updateProfile,
} from "@/services/auth/auth.service";

const SignupSchema = z.object({
  /** 'business' creates a team workspace with seats; 'personal' a solo one. */
  accountType: z.enum(["business", "personal"]).default("personal"),
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  organizationName: z.string().max(200).optional(),
  companyName: z.string().max(200).optional(),
  companyDescription: z.string().max(2000).optional(),
});

const LoginSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(10).max(500) });

const ProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
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

function clientIp(req: Request): string {
  // Behind Render's proxy; app.set('trust proxy') makes req.ip the real one.
  return req.ip ?? "unknown";
}

/** POST /api/auth/signup — creates an organization and its first admin. */
export async function postSignup(req: Request, res: Response): Promise<void> {
  const body = parse(SignupSchema, req.body);
  const result = await signup(body);
  res.status(201).json(result);
}

/** POST /api/auth/login */
export async function postLogin(req: Request, res: Response): Promise<void> {
  const body = parse(LoginSchema, req.body);
  const result = await login({ ...body, ip: clientIp(req) });
  res.json(result);
}

/** POST /api/auth/refresh — also where role/seat/suspension changes land. */
export async function postRefresh(req: Request, res: Response): Promise<void> {
  const body = parse(RefreshSchema, req.body);
  const result = await refresh(body.refreshToken);
  res.json(result);
}

/** POST /api/auth/logout — revokes the presented refresh token. */
export async function postLogout(req: Request, res: Response): Promise<void> {
  const body = parse(RefreshSchema, req.body);
  await logout(body.refreshToken);
  res.json({ ok: true });
}

/** GET /api/auth/me — the user and the workspace they act in. */
export async function getMe(req: Request, res: Response): Promise<void> {
  const { userId } = authOf(req);
  const session = await getSessionUser(userId);
  if (!session) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Account no longer exists." },
    });
    return;
  }
  res.json(session);
}

/** PATCH /api/auth/me — personal details only (company profile is org-level). */
export async function patchMe(req: Request, res: Response): Promise<void> {
  const { userId } = authOf(req);
  const body = parse(ProfileSchema, req.body);
  const user = await updateProfile(userId, body);
  res.json({ user });
}

/**
 * POST /api/auth/password — change your own password.
 *
 * Deliberately behind `requireAuth` alone: it is identity, not workspace, so
 * members, organization admins and platform admins can all reach it. The
 * response carries a fresh token pair because the change revokes every
 * session, including the caller's.
 */
export async function postChangePassword(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const body = parse(ChangePasswordSchema, req.body);
  const result = await changePassword(userId, body);
  res.json(result);
}
