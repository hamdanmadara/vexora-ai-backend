import { logger, type Logger } from "@/utils/logger";
import type {
  AIResponse,
  ChannelId,
  IChannelAdapter,
  InboundChannelMessage,
  OutboundTarget,
} from "./types";

/**
 * Shared scaffolding for concrete adapters (Zendesk, WhatsApp, ...). Owns
 * nothing platform-specific — just what every adapter would otherwise
 * duplicate: its channel id and a consistently-tagged logger. Platform
 * translation (normalizeInbound/sendReply) always belongs to the subclass.
 */
export abstract class BaseChannelAdapter implements IChannelAdapter {
  public readonly channel: ChannelId;
  protected readonly logger: Logger;

  protected constructor(channel: ChannelId) {
    this.channel = channel;
    this.logger = logger.child({ channel });
  }

  abstract normalizeInbound(raw: unknown): InboundChannelMessage;
  abstract sendReply(
    target: OutboundTarget,
    response: AIResponse
  ): Promise<void>;
}
