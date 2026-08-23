import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import type { ZendeskCredentials } from "@/services/integrations/providers";
import type { SunshineSendMessagePayload } from "./zendesk.types";

/** Max 3 attempts total, exponential backoff (1s, 2s) — Phase 2 design doc, retry flow. */
const RETRY_DELAYS_MS = [1000, 2000];

/**
 * Stateless Sunshine Conversations client: every call takes the workspace's
 * own credentials (from its integrations row) — nothing global.
 */
function authHeader(creds: ZendeskCredentials): string {
  const token = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString(
    "base64"
  );
  return `Basic ${token}`;
}

async function postMessage(
  creds: ZendeskCredentials,
  conversationId: string,
  payload: SunshineSendMessagePayload
): Promise<void> {
  const url = `${env.ZENDESK_API_BASE_URL}/apps/${creds.appId}/conversations/${conversationId}/messages`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader(creds),
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      lastErr = new Error(
        `Sunshine send-message failed: ${res.status} ${await res.text()}`
      );
    } catch (err) {
      lastErr = err;
    }

    const delay = RETRY_DELAYS_MS[attempt];
    if (delay == null) break; // out of retries

    logger.warn(
      { conversationId, attempt: attempt + 1, err: lastErr },
      "Retrying Sunshine send-message"
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  logger.error(
    { conversationId, err: lastErr },
    "Sunshine send-message failed after retries"
  );
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function sendTextMessage(
  creds: ZendeskCredentials,
  conversationId: string,
  text: string
): Promise<void> {
  await postMessage(creds, conversationId, {
    author: { type: "business" },
    content: { type: "text", text },
  });
}
