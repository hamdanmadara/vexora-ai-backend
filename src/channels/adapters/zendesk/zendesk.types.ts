/**
 * Sunshine Conversations webhook + API payload shapes.
 *
 * CONFIRMED against a real webhook delivery from a live Zendesk Messaging
 * trial account (2026-08-08) — events array, author.type, content.text all
 * match as documented below. Auth does NOT use these shapes: see
 * zendesk.controller.ts for the (also confirmed) x-api-key header check.
 */

export interface SunshineMessageAuthor {
  /** "user" = the customer; "business" = us (our own outbound messages echoed back). */
  type: "user" | "business" | string;
  userId?: string;
  displayName?: string;
}

export interface SunshineMessageContent {
  type: string; // "text" for plain messages; other types (image, carousel, ...) exist but are out of scope for v1 (no attachment support).
  text?: string;
}

export interface SunshineMessage {
  id: string;
  author: SunshineMessageAuthor;
  content: SunshineMessageContent;
}

export interface SunshineWebhookEvent {
  type: string; // e.g. "conversation:message"
  payload: {
    conversation: { id: string };
    message?: SunshineMessage;
  };
}

export interface SunshineWebhookBody {
  app?: { id: string };
  webhook?: { id: string };
  events: SunshineWebhookEvent[];
}

export interface SunshineSendMessagePayload {
  author: { type: "business" };
  content: { type: "text"; text: string };
}
