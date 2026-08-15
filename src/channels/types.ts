/**
 * Omnichannel framework — shared types.
 *
 * These are the only shapes a channel adapter and the Channel Manager agree
 * on. The chat core (ChatService) never sees a platform-specific payload —
 * only a ChannelMessage in, an AIResponse out. See the Phase 2 design doc
 * for the full architecture this implements.
 */

export type ChannelId = string;

/** Known channel ids in use today — informational, not exhaustive. */
export const CHANNELS = {
  web: "web",
  zendesk: "zendesk",
} as const;

export interface ChannelCustomer {
  /** The platform's own id for this person (e.g. a Sunshine conversation user id). */
  externalId: string;
  name?: string;
  email?: string;
}

/**
 * What an adapter hands to the Channel Manager after translating a raw
 * platform payload. No sessionId yet — the Channel Manager owns session
 * mapping (see session-key.ts) so adapters never invent their own scheme.
 */
export interface InboundChannelMessage {
  channel: ChannelId;
  customer: ChannelCustomer;
  text: string;
  /** Raw platform fields worth keeping for logging/dedup (e.g. a provider message id). Never read by the chat core. */
  metadata?: Record<string, unknown>;
}

/** An InboundChannelMessage with its internal session resolved — this is what reaches ChatService. */
export interface ChannelMessage extends InboundChannelMessage {
  sessionId: string;
}

/**
 * What the chat core hands back, translated into a shape every adapter can
 * render in its own platform's format. Only `text` is populated by the core
 * today — the rest are reserved for capabilities the core doesn't implement
 * yet (see the Phase 2 design doc, "Common Models").
 */
export interface AIResponse {
  text: string;
  /** Reserved: no agent currently signals this. Always false until that logic exists. */
  handoffRequired: boolean;
  /** Reserved: generateChat is single-shot and has no typing/status phases (unlike the web SSE path). */
  typing?: boolean;
  /** Reserved: not modeled by any agent yet. */
  suggestedActions?: string[];
  /** Reserved: attachments are out of scope for v1 (Phase 1 decision). */
  attachments?: unknown[];
}

/** Where an adapter should deliver an AIResponse back to the customer. */
export interface OutboundTarget {
  sessionId: string;
  /** The platform's own id for the conversation/user (e.g. a Sunshine conversation id). */
  externalId: string;
  metadata?: Record<string, unknown>;
}

/**
 * The contract every channel (Zendesk, WhatsApp, Messenger, ...) implements.
 * The Channel Manager and ChatService only ever talk to this interface —
 * neither knows or cares which platform is on the other side.
 */
export interface IChannelAdapter {
  readonly channel: ChannelId;
  /** Translate a raw, platform-specific payload into the common shape. */
  normalizeInbound(raw: unknown): InboundChannelMessage;
  /** Translate an AIResponse into a platform-specific call and deliver it. */
  sendReply(target: OutboundTarget, response: AIResponse): Promise<void>;
}
