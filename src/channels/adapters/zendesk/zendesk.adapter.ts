import { BaseChannelAdapter } from "@/channels/base-channel-adapter";
import { CHANNELS } from "@/channels/types";
import type {
  AIResponse,
  InboundChannelMessage,
  OutboundTarget,
} from "@/channels/types";
import { BadRequestError } from "@/utils/errors";
import { sendTextMessage } from "./zendesk-api.service";
import type { SunshineWebhookEvent } from "./zendesk.types";

/**
 * Translates between Sunshine Conversations' wire format and the common
 * ChannelMessage/AIResponse shapes. No business logic lives here — every
 * inbound event is handed to the Channel Manager, which calls ChatService
 * exactly as the web chat does.
 *
 * Which events are worth acting on (customer messages vs. our own echoed
 * replies, typing events, etc.) is decided by the controller, which only
 * ever passes this adapter events it has already determined are actionable.
 */
export class ZendeskAdapter extends BaseChannelAdapter {
  constructor() {
    super(CHANNELS.zendesk);
  }

  /** `raw` is one event from a Sunshine webhook's `events` array. */
  normalizeInbound(raw: unknown): InboundChannelMessage {
    const event = raw as SunshineWebhookEvent;
    const conversationId = event.payload?.conversation?.id;
    const message = event.payload?.message;
    const text = message?.content?.text;

    if (!conversationId || !message || !text) {
      throw new BadRequestError("Unrecognized Zendesk webhook event shape");
    }

    return {
      channel: this.channel,
      // The conversation id, not the person's id, is the unit of identity
      // we key sessions on for v1 (no cross-channel lead merge — Phase 1
      // decision). See session-key.ts.
      customer: {
        externalId: conversationId,
        name: message.author.displayName,
      },
      text,
      metadata: {
        sunshineMessageId: message.id,
        sunshineConversationId: conversationId,
        sunshineUserId: message.author.userId,
      },
    };
  }

  async sendReply(
    target: OutboundTarget,
    response: AIResponse
  ): Promise<void> {
    await sendTextMessage(target.externalId, response.text);
  }
}

export const zendeskAdapter = new ZendeskAdapter();
