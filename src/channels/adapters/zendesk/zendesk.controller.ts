import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env, featureFlags } from "@/config/env";
import { logger } from "@/utils/logger";
import { handleInbound } from "@/channels/channel-manager";
import type { ChannelContext } from "@/channels/types";
import { getIntegrationByWebhookToken } from "@/services/integrations/integrations.service";
import { zendeskAdapter } from "./zendesk.adapter";
import type { SunshineWebhookBody, SunshineWebhookEvent } from "./zendesk.types";

/**
 * CONFIRMED against a real webhook delivery (2026-08-08): Zendesk
 * Conversations does not sign the body with HMAC — it sends the
 * integration's shared secret directly, unchanged, as this header on every
 * request. Verification is a constant-time equality check, not a digest.
 */
const API_KEY_HEADER = "x-api-key";

function secretsMatch(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Only customer-authored messages are worth an AI turn — filters out our
 * own echoed replies and non-message events (typing, read receipts, etc.).
 */
function isActionableCustomerMessage(event: SunshineWebhookEvent): boolean {
  return (
    event.type === "conversation:message" &&
    event.payload?.message?.author?.type === "user"
  );
}

/**
 * Best-effort, single-instance dedup only. Guards against Sunshine
 * redelivering a webhook (e.g. a network blip after our 200 ack was sent
 * but before Sunshine received it) causing a duplicate AI reply. A
 * multi-instance deployment needs a shared store (Redis/Postgres) instead
 * of this in-memory set.
 */
const processedMessageIds = new Set<string>();
const MAX_TRACKED_IDS = 5000;

function alreadyProcessed(messageId: string | undefined): boolean {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  if (processedMessageIds.size >= MAX_TRACKED_IDS) {
    processedMessageIds.clear();
  }
  processedMessageIds.add(messageId);
  return false;
}

/** Shared tail: ack fast, then process each actionable event under `ctx`. */
async function processWebhookBody(
  req: Request,
  res: Response,
  ctx: ChannelContext
): Promise<void> {
  // Ack immediately — Sunshine expects a fast 200 and otherwise retries
  // delivery, which is exactly what the dedup set above guards against.
  res.status(200).json({ ok: true });

  const body = req.body as SunshineWebhookBody;
  const events = Array.isArray(body?.events) ? body.events : [];

  for (const event of events) {
    if (!isActionableCustomerMessage(event)) continue;

    const messageId = event.payload?.message?.id;
    if (alreadyProcessed(messageId)) continue;

    try {
      const inbound = zendeskAdapter.normalizeInbound(event);
      await handleInbound(inbound, ctx);
    } catch (err) {
      logger.error({ err, event }, "Failed to handle Zendesk webhook event");
    }
  }
}

/**
 * POST /api/channels/zendesk/webhook/:token — the per-workspace route.
 * The token IDENTIFIES the integration (and thus the tenant + credentials);
 * the stored shared secret still AUTHENTICATES the delivery. Unknown token
 * and bad secret are indistinguishable (both 401) so probing reveals
 * nothing.
 */
export async function postZendeskWebhookForToken(
  req: Request<{ token: string }>,
  res: Response
): Promise<void> {
  const integration = await getIntegrationByWebhookToken(
    "zendesk",
    String(req.params.token ?? "")
  );
  const providedKey = req.header(API_KEY_HEADER);

  if (
    !integration ||
    !secretsMatch(providedKey, integration.credentials.webhookSecret)
  ) {
    logger.warn("Rejected Zendesk webhook: unknown token or invalid x-api-key");
    res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } });
    return;
  }

  await processWebhookBody(req, res, {
    integrationId: integration.id,
    tenantId: integration.tenantId,
    credentials: integration.credentials,
  });
}

/**
 * POST /api/channels/zendesk/webhook — LEGACY env-configured route, kept so
 * an already-registered webhook keeps working during the migration to
 * per-user integrations. Remove once every workspace has re-registered its
 * tokenized URL.
 */
export async function postZendeskWebhook(
  req: Request,
  res: Response
): Promise<void> {
  if (!featureFlags.zendeskReady) {
    res.status(503).json({
      error: {
        code: "FEATURE_DISABLED",
        message: "Zendesk is not configured. Check your .env file.",
      },
    });
    return;
  }

  if (!secretsMatch(req.header(API_KEY_HEADER), env.ZENDESK_WEBHOOK_SECRET)) {
    logger.warn("Rejected Zendesk webhook (legacy): invalid x-api-key");
    res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } });
    return;
  }

  await processWebhookBody(req, res, {
    // Not a real integrations row: touchLastEvent no-ops harmlessly, and the
    // session scope stays distinct from tokenized traffic.
    integrationId: "env",
    tenantId: env.ZENDESK_TENANT_ID ?? "default",
    credentials: {
      appId: env.ZENDESK_APP_ID ?? "",
      keyId: env.ZENDESK_API_KEY_ID ?? "",
      keySecret: env.ZENDESK_API_KEY_SECRET ?? "",
      webhookSecret: env.ZENDESK_WEBHOOK_SECRET ?? "",
    },
  });
}
