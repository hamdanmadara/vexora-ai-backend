/**
 * Light-weight Supabase REST client wrapper.
 *
 * We mostly talk to Postgres directly via `pg`, but a few endpoints
 * (storage in the future, auth later) benefit from `@supabase/supabase-js`.
 * It's not strictly required today, so we lazy-load and tolerate its absence.
 */
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";

// Use a minimal fetch-based helper for now — we don't need the full SDK.
export function supabaseFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!featureFlags.supabaseReady) {
    throw new FeatureDisabledError("Supabase");
  }
  const url = `${env.SUPABASE_URL!.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init.headers);
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY!);
  headers.set("Authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}
