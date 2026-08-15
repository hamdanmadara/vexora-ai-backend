/**
 * Namespaces a channel's own conversation/user id into the internal
 * session_id every lead is keyed by, so two channels can never collide in
 * the leads.session_id unique column (Phase 2 design doc, "Session /
 * Identity Flow").
 *
 * Web chat is exempt: it already mints its own unprefixed UUID and never
 * goes through the Channel Manager, so it's untouched by this convention.
 */
export function buildSessionId(channel: string, externalId: string): string {
  return `${channel}:${externalId}`;
}
