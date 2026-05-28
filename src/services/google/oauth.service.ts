import { google } from "googleapis";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError, UnauthorizedError } from "@/utils/errors";
import {
  getGoogleCredentials,
  saveGoogleCredentials,
  updateAccessToken,
} from "./credentials.service";

/** Full calendar access: create events, read free/busy, list calendars. */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function requireGoogleConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  if (!featureFlags.googleReady) {
    throw new FeatureDisabledError("Google OAuth");
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

export function createOAuthClient() {
  const cfg = requireGoogleConfig();
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

export function buildAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token + new scopes on reconnect
    scope: SCOPES,
    state,
  });
}

/**
 * Exchange the `code` from Google's redirect for tokens, look up the
 * connected account's email, and persist a row in google_credentials.
 */
export async function handleOAuthCallback(
  code: string,
  salesRepId: string
): Promise<{ email: string | null }> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    // This happens when the user previously connected and revoked without
    // logging out — Google then refuses to issue a new refresh token.
    throw new UnauthorizedError(
      "Google did not return a refresh token. Please remove access at https://myaccount.google.com/permissions and try again."
    );
  }

  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const userinfo = await oauth2.userinfo.get();
    email = userinfo.data.email ?? null;
  } catch {
    // Not fatal if userinfo fails.
  }

  await saveGoogleCredentials({
    salesRepId,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date ?? null,
    scope: tokens.scope ?? null,
    tokenType: tokens.token_type ?? null,
    googleEmail: email,
  });

  return { email };
}

/**
 * Returns an OAuth2 client primed with the sales rep's stored credentials.
 * Automatically refreshes the access token if expired and persists the new one.
 */
export async function getAuthorizedClient(salesRepId: string) {
  const creds = await getGoogleCredentials(salesRepId);
  if (!creds) {
    throw new UnauthorizedError(
      "This sales rep hasn't connected Google yet. Visit /api/auth/google/connect."
    );
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: creds.access_token ?? undefined,
    refresh_token: creds.refresh_token,
    expiry_date: creds.expiry_date ?? undefined,
    scope: creds.scope ?? undefined,
    token_type: creds.token_type ?? undefined,
  });

  client.on("tokens", (tokens) => {
    if (tokens.access_token && tokens.expiry_date) {
      void updateAccessToken({
        salesRepId,
        accessToken: tokens.access_token,
        expiryDate: tokens.expiry_date,
      });
    }
  });

  return client;
}

export async function isGoogleConnected(salesRepId: string): Promise<boolean> {
  if (!featureFlags.googleReady) return false;
  const creds = await getGoogleCredentials(salesRepId);
  return !!creds;
}

/**
 * True only if stored tokens can call Calendar freeBusy (not just "row exists").
 * Old connections made before we added full calendar scope will return false.
 */
export async function isCalendarApiReady(salesRepId: string): Promise<boolean> {
  if (!(await isGoogleConnected(salesRepId))) return false;
  try {
    const auth = await getAuthorizedClient(salesRepId);
    const calendar = google.calendar({ version: "v3", auth });
    const now = new Date();
    const later = new Date(now.getTime() + 3600_000);
    await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: later.toISOString(),
        items: [{ id: "primary" }],
      },
    });
    return true;
  } catch {
    return false;
  }
}
