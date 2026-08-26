import type { Request, Response } from "express";
import { env } from "@/config/env";
import {
  buildAuthUrl,
  disconnectGoogle,
  handleOAuthCallback,
  isCalendarApiReady,
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

  // This is a browser navigation from Google — land the user back in the
  // app either way, with the outcome in the query string, instead of
  // stranding them on a JSON error or a dead-end "close this tab" page.
  const settingsUrl = `${env.FRONTEND_BASE_URL}/settings`;

  try {
    if (!code) throw new BadRequestError("Missing OAuth code");
    if (!state) throw new BadRequestError("Missing OAuth state");

    const userId = verifyOAuthState(state);
    await handleOAuthCallback(code, userId);
    res.redirect(`${settingsUrl}?google=connected`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    res.redirect(
      `${settingsUrl}?google=error&message=${encodeURIComponent(message.slice(0, 200))}`
    );
  }
}

/**
 * DELETE /api/auth/google  (authenticated) — disconnect this user's
 * calendar: revoke at Google (best-effort) + remove stored credentials.
 */
export async function googleDisconnect(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const removed = await disconnectGoogle(userId);
  res.json({ ok: true, removed });
}

/**
 * GET /api/auth/google/status  (authenticated) — this user's connection.
 * `connected` means a credentials row exists; `calendarReady` is a LIVE
 * Calendar API check, so a revoked token or a consent given without the
 * calendar checkbox shows up as needsReconnect instead of a false green.
 */
export async function googleStatus(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const connected = await isGoogleConnected(userId);
  const creds = connected ? await getGoogleCredentials(userId) : null;
  const calendarReady = connected ? await isCalendarApiReady(userId) : false;
  res.json({
    connected,
    calendarReady,
    needsReconnect: connected && !calendarReady,
    email: creds?.google_email ?? null,
  });
}
