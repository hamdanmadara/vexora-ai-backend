import { getPool } from "@/db/pool";
import { env } from "@/config/env";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import {
  decryptJson,
  encryptJson,
  generateWebhookToken,
  maskSecret,
} from "./crypto";
import { getProvider, type ProviderDefinition } from "./providers";

export interface IntegrationRow {
  id: string;
  tenant_id: string;
  provider: string;
  status: "active" | "disabled" | "error";
  credentials: string;
  metadata: Record<string, unknown>;
  webhook_token: string;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

/** An integration with decrypted credentials — internal use only, never serialized. */
export interface ResolvedIntegration {
  id: string;
  tenantId: string;
  provider: string;
  status: IntegrationRow["status"];
  credentials: Record<string, string>;
  metadata: Record<string, unknown>;
  webhookToken: string;
}

/** What the API returns: secrets masked, webhook URL ready to copy. */
export interface PublicIntegration {
  provider: string;
  status: IntegrationRow["status"];
  webhookUrl: string;
  webhookTriggers: string[];
  /** field key -> masked value (secret fields) or full value (non-secret). */
  credentials: Record<string, string>;
  metadata: Record<string, unknown>;
  lastEventAt: string | null;
  updatedAt: string;
}

function webhookUrlFor(provider: string, token: string): string {
  return `${env.BACKEND_BASE_URL}/api/channels/${provider}/webhook/${token}`;
}

function resolve(row: IntegrationRow): ResolvedIntegration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    status: row.status,
    credentials: decryptJson<Record<string, string>>(row.credentials),
    metadata: row.metadata,
    webhookToken: row.webhook_token,
  };
}

function toPublic(
  row: IntegrationRow,
  def: ProviderDefinition
): PublicIntegration {
  const creds = decryptJson<Record<string, string>>(row.credentials);
  const masked: Record<string, string> = {};
  for (const field of def.fields) {
    const value = creds[field.key];
    if (value == null) continue;
    masked[field.key] = field.secret ? maskSecret(value) : value;
  }
  return {
    provider: row.provider,
    status: row.status,
    webhookUrl: webhookUrlFor(row.provider, row.webhook_token),
    webhookTriggers: def.webhookTriggers,
    credentials: masked,
    metadata: row.metadata,
    lastEventAt: row.last_event_at
      ? new Date(row.last_event_at).toISOString()
      : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listIntegrations(
  tenantId: string
): Promise<PublicIntegration[]> {
  const pool = getPool();
  const { rows } = await pool.query<IntegrationRow>(
    `select * from integrations where tenant_id = $1 order by provider`,
    [tenantId]
  );
  return rows.flatMap((row) => {
    const def = getProvider(row.provider);
    return def ? [toPublic(row, def)] : [];
  });
}

/**
 * Create or replace a provider connection. Credentials are validated by
 * shape (zod) AND by a live call to the provider before anything is saved —
 * a typo fails here with a clear message, not silently at the customer's
 * first message. The webhook token survives re-saves so the URL the user
 * already registered keeps working.
 */
export async function upsertIntegration(
  tenantId: string,
  providerId: string,
  input: Record<string, unknown>
): Promise<PublicIntegration> {
  const def = getProvider(providerId);
  if (!def) throw new NotFoundError(`Unknown provider "${providerId}"`);

  const parsed = def.credentialsSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BadRequestError(
      first ? `${first.path.join(".")}: ${first.message}` : "Invalid credentials"
    );
  }

  const verdict = await def.verify(parsed.data);
  if (!verdict.ok) {
    throw new BadRequestError(
      verdict.error ?? "The provider rejected these credentials."
    );
  }

  const pool = getPool();
  const encrypted = encryptJson(parsed.data);
  const { rows } = await pool.query<IntegrationRow>(
    `insert into integrations
       (tenant_id, provider, status, credentials, metadata, webhook_token)
     values ($1, $2, 'active', $3, $4, $5)
     on conflict (tenant_id, provider) do update
        set credentials = excluded.credentials,
            metadata = excluded.metadata,
            status = 'active'
     returning *`,
    [
      tenantId,
      providerId,
      encrypted,
      JSON.stringify(verdict.metadata ?? {}),
      generateWebhookToken(),
    ]
  );

  logger.info({ tenantId, provider: providerId }, "integration saved");
  return toPublic(rows[0]!, def);
}

export async function deleteIntegration(
  tenantId: string,
  providerId: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `delete from integrations where tenant_id = $1 and provider = $2`,
    [tenantId, providerId]
  );
  if (!rowCount) throw new NotFoundError("Integration not found");
}

/** New webhook URL; the old one stops working immediately. */
export async function rotateWebhookToken(
  tenantId: string,
  providerId: string
): Promise<PublicIntegration> {
  const def = getProvider(providerId);
  if (!def) throw new NotFoundError(`Unknown provider "${providerId}"`);
  const pool = getPool();
  const { rows } = await pool.query<IntegrationRow>(
    `update integrations set webhook_token = $3
      where tenant_id = $1 and provider = $2
      returning *`,
    [tenantId, providerId, generateWebhookToken()]
  );
  if (!rows[0]) throw new NotFoundError("Integration not found");
  return toPublic(rows[0], def);
}

/** Webhook dispatch: token -> integration (with decrypted credentials). */
export async function getIntegrationByWebhookToken(
  provider: string,
  token: string
): Promise<ResolvedIntegration | null> {
  if (!token) return null;
  const pool = getPool();
  const { rows } = await pool.query<IntegrationRow>(
    `select * from integrations
      where provider = $1 and webhook_token = $2 and status <> 'disabled'`,
    [provider, token]
  );
  return rows[0] ? resolve(rows[0]) : null;
}

/** Health signal for the UI; fire-and-forget from the webhook hot path. */
export function touchLastEvent(integrationId: string): void {
  const pool = getPool();
  void pool
    .query(`update integrations set last_event_at = now() where id = $1`, [
      integrationId,
    ])
    .catch(() => undefined);
}
