import { z } from "zod";
import { env } from "@/config/env";

/**
 * Provider registry — the single place that knows what each external tool
 * needs. Adding a new integration (WhatsApp, Messenger, ...) means adding
 * one entry here + a channel adapter; no DB migration, no new endpoints.
 *
 * `fields` drives the frontend form; `secret: true` fields are masked in
 * every API response after save.
 */

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Human-readable failure ("Invalid API key", ...) when ok=false. */
  error?: string;
  /** Non-secret facts learned during verification, merged into metadata. */
  metadata?: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  description: string;
  /** Which webhook trigger(s) the user must select in the provider's UI. */
  webhookTriggers: string[];
  fields: ProviderField[];
  credentialsSchema: z.ZodType<Record<string, string>>;
  /** Live test-call against the provider BEFORE credentials are saved. */
  verify(credentials: Record<string, string>): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Zendesk (Sunshine Conversations)
// ---------------------------------------------------------------------------

export interface ZendeskCredentials {
  appId: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

const zendeskSchema = z.object({
  appId: z.string().min(8, "App ID looks too short"),
  keyId: z.string().min(8, "Key ID looks too short"),
  keySecret: z.string().min(16, "Key Secret looks too short"),
  webhookSecret: z.string().min(16, "Webhook Shared Secret looks too short"),
}) satisfies z.ZodType<Record<string, string>>;

async function verifyZendesk(
  credentials: Record<string, string>
): Promise<VerifyResult> {
  const { appId, keyId, keySecret } = credentials as unknown as ZendeskCredentials;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  try {
    const res = await fetch(`${env.ZENDESK_API_BASE_URL}/apps/${appId}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Zendesk rejected the Key ID / Key Secret." };
    }
    if (res.status === 404) {
      return { ok: false, error: "No Zendesk app found with that App ID." };
    }
    if (!res.ok) {
      return { ok: false, error: `Zendesk returned HTTP ${res.status}.` };
    }
    const body = (await res.json()) as {
      app?: { displayName?: string; subdomain?: string };
    };
    return {
      ok: true,
      metadata: {
        appDisplayName: body.app?.displayName ?? null,
        subdomain: body.app?.subdomain ?? null,
      },
    };
  } catch {
    return {
      ok: false,
      error: "Could not reach the Zendesk API — check your network and try again.",
    };
  }
}

export const PROVIDERS: Record<string, ProviderDefinition> = {
  zendesk: {
    id: "zendesk",
    name: "Zendesk Messaging",
    description:
      "Answer customers in your Zendesk web widget with your AI assistant.",
    webhookTriggers: ["conversation:message"],
    fields: [
      {
        key: "appId",
        label: "App ID",
        secret: false,
        help: "Admin Center → Apps and integrations → APIs → Conversations API",
      },
      { key: "keyId", label: "API Key ID", secret: false },
      { key: "keySecret", label: "API Key Secret", secret: true },
      {
        key: "webhookSecret",
        label: "Webhook Shared Secret",
        secret: true,
        help: "Shown by Zendesk when you create the webhook (step 2).",
      },
    ],
    credentialsSchema: zendeskSchema,
    verify: verifyZendesk,
  },
};

export function getProvider(id: string): ProviderDefinition | null {
  return PROVIDERS[id] ?? null;
}
