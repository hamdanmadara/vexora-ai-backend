import { generateChat } from "@/services/chat/chat.service";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import { buildSessionId } from "./session-key";
import type {
  AIResponse,
  ChannelMessage,
  IChannelAdapter,
  InboundChannelMessage,
} from "./types";

/**
 * Thin dispatcher between channel adapters and the chat core. Holds no
 * business logic — routing, RAG, scheduling, and memory all live in
 * ChatService exactly as they do for web chat today. This module only does
 * adapter bookkeeping and session mapping.
 *
 * A module-level registry (mirroring db/pool.ts's singleton pattern) rather
 * than a class: there is exactly one Channel Manager, and it has no
 * polymorphic variants that would call for a class.
 */
const adapters = new Map<string, IChannelAdapter>();

export function registerAdapter(adapter: IChannelAdapter): void {
  if (adapters.has(adapter.channel)) {
    throw new Error(
      `Adapter already registered for channel "${adapter.channel}"`
    );
  }
  adapters.set(adapter.channel, adapter);
}

export function getAdapter(channel: string): IChannelAdapter {
  const adapter = adapters.get(channel);
  if (!adapter) {
    throw new Error(`No adapter registered for channel "${channel}"`);
  }
  return adapter;
}

/**
 * Runs one full inbound turn: resolve the session, call the chat core, then
 * deliver the reply back through the adapter it arrived on.
 */
export async function handleInbound(
  inbound: InboundChannelMessage
): Promise<AIResponse> {
  const adapter = getAdapter(inbound.channel);
  const sessionId = buildSessionId(
    inbound.channel,
    inbound.customer.externalId
  );
  const message: ChannelMessage = { ...inbound, sessionId };

  logger.debug(
    { channel: message.channel, sessionId },
    "Channel Manager: dispatching inbound message"
  );

  // The env-configured Zendesk integration belongs to exactly one workspace
  // (ZENDESK_TENANT_ID). Per-user channel connections replace this mapping
  // in a later phase.
  const { reply } = await generateChat({
    sessionId: message.sessionId,
    message: message.text,
    tenantId: env.ZENDESK_TENANT_ID ?? "default",
    channel: message.channel,
  });

  const response: AIResponse = {
    text: reply,
    handoffRequired: false,
  };

  await adapter.sendReply(
    {
      sessionId: message.sessionId,
      externalId: message.customer.externalId,
      metadata: message.metadata,
    },
    response
  );

  return response;
}
