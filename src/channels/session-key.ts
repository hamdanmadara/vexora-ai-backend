/**
 * Namespaces a channel's own conversation/user id into the internal
 * session_id every lead is keyed by, so two channels — and two workspaces'
 * accounts on the SAME channel — can never collide in leads.session_id.
 *
 * Format: `{channel}:{integrationId}:{externalId}`. The integration id is
 * the scoping unit because two businesses can have identical conversation
 * ids on the same platform.
 *
 * Web chat is exempt: it already mints its own unprefixed UUID and never
 * goes through the Channel Manager, so it's untouched by this convention.
 */
export function buildSessionId(
  channel: string,
  integrationId: string,
  externalId: string
): string {
  return `${channel}:${integrationId}:${externalId}`;
}
