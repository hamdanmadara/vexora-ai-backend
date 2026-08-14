import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { SunshineSendMessagePayload } from "./zendesk.types";

/** Max 3 attempts total, exponential backoff (1s, 2s) — Phase 2 design doc, retry flow. */
const RETRY_DELAYS_MS = [1000, 2000];

function authHeader(): string {
  const token = Buffer.from(
    `${env.ZENDESK_API_KEY_ID}:${env.ZENDESK_API_KEY_SECRET}`
  ).toString("base64");
  return `Basic ${token}`;
}

function ensureReady(): void {
  if (!featureFlags.zendeskReady) {
    throw new FeatureDisabledError("Zendesk");
  }
}

async function postMessage(
  conversationId: string,
  payload: SunshineSendMessagePayload
): Promise<void> {
  const url = `${env.ZENDESK_API_BASE_URL}/apps/${env.ZENDESK_APP_ID}/conversations/${conversationId}/messages`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader(),
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
  conversationId: string,
  text: string
): Promise<void> {
  ensureReady();
  await postMessage(conversationId, {
    author: { type: "business" },
    content: { type: "text", text },
  });
}
