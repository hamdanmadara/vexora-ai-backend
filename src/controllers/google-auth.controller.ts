import type { Request, Response } from "express";
import {
  buildAuthUrl,
  handleOAuthCallback,
  isGoogleConnected,
} from "@/services/google/oauth.service";
import { getGoogleCredentials } from "@/services/google/credentials.service";
import { BadRequestError } from "@/utils/errors";
import { authOf } from "@/middleware/require-auth";
import {
  signOAuthState,
  verifyOAuthState,
} from "@/services/auth/token.service";

/**
 * GET /api/auth/google/connect  (authenticated)
 *
 * Returns the Google consent URL as JSON rather than redirecting: the
 * browser navigation that follows can't carry a bearer token, so the
 * frontend fetches this (authenticated), then navigates to `url`. The
 * signed state binds the eventual callback to this user.
 */
export async function startGoogleAuth(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const url = buildAuthUrl(signOAuthState(userId));
  res.json({ url });
}

/**
 * GET /api/auth/google/callback  (public — Google's redirect)
 *
 * The state param is our HMAC-signed user binding; an invalid or expired
 * state is rejected, so a forged callback can't attach a calendar to
 * someone else's workspace.
 */
export async function googleAuthCallback(
  req: Request,
  res: Response
): Promise<void> {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code) throw new BadRequestError("Missing OAuth code");
  if (!state) throw new BadRequestError("Missing OAuth state");

  const userId = verifyOAuthState(state);
  const result = await handleOAuthCallback(code, userId);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Google connected</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 40px; max-width: 480px; margin: 40px auto; }
  .ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 16px 20px; border-radius: 12px; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
</style></head><body>
<div class="ok">
  <h2 style="margin:0 0 8px">Google connected!</h2>
  <p style="margin:0">Connected account: <code>${result.email ?? "(unknown)"}</code></p>
  <p>Vexora can now book meetings on this calendar. You can close this tab.</p>
</div>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

/** GET /api/auth/google/status  (authenticated) — this user's connection. */
export async function googleStatus(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const connected = await isGoogleConnected(userId);
  const creds = connected ? await getGoogleCredentials(userId) : null;
  res.json({
    connected,
    email: creds?.google_email ?? null,
  });
}
