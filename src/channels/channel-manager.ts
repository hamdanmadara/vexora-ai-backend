import { generateChat } from "@/services/chat/chat.service";
import { touchLastEvent } from "@/services/integrations/integrations.service";
import { logger } from "@/utils/logger";
import { buildSessionId } from "./session-key";
import type {
  AIResponse,
  ChannelContext,
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
 * Runs one full inbound turn for a resolved integration: map the session
 * (scoped by integration so workspaces never collide), call the chat core
 * under that workspace's tenant, then deliver the reply back through the
 * adapter with that workspace's credentials.
 */
export async function handleInbound(
  inbound: InboundChannelMessage,
  ctx: ChannelContext
): Promise<AIResponse> {
  const adapter = getAdapter(inbound.channel);
  const sessionId = buildSessionId(
    inbound.channel,
    ctx.integrationId,
    inbound.customer.externalId
  );
  const message: ChannelMessage = { ...inbound, sessionId };

  touchLastEvent(ctx.integrationId);

  logger.debug(
    { channel: message.channel, sessionId, tenantId: ctx.tenantId },
    "Channel Manager: dispatching inbound message"
  );

  const { reply } = await generateChat({
    sessionId: message.sessionId,
    message: message.text,
    tenantId: ctx.tenantId,
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
    response,
    ctx
  );

  return response;
}
