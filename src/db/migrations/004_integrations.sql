-- =============================================================================
-- Vexora AI - Per-user channel integrations
-- =============================================================================
-- One generic table for every external tool a workspace connects (Zendesk
-- today; WhatsApp / Messenger / others later). Provider-specific key shapes
-- live in `credentials` (encrypted JSON blob, AES-256-GCM — see
-- services/integrations/crypto.ts); adding a new provider needs NO migration.
-- Idempotent: safe to run multiple times.
-- =============================================================================

create table if not exists integrations (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      text        not null,            -- users.id
  provider       text        not null,            -- 'zendesk' | 'whatsapp' | ...
  status         text        not null default 'active',
  -- Encrypted JSON: iv.tag.ciphertext (base64url), never plaintext.
  credentials    text        not null,
  -- Non-secret provider config (display name, subdomain, connected app name).
  metadata       jsonb       not null default '{}',
  -- Random per-integration token baked into the user's webhook URL:
  --   /api/channels/{provider}/webhook/{webhook_token}
  -- It IDENTIFIES the workspace; the provider's shared secret (inside
  -- credentials) still AUTHENTICATES each delivery.
  webhook_token  text        not null unique,
  -- Health signal for the UI ("last message received ...").
  last_event_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint integrations_status_chk check (status in ('active', 'disabled', 'error')),
  -- One connection per provider per workspace (relax later if a business
  -- ever needs two Zendesk accounts).
  constraint integrations_tenant_provider_uniq unique (tenant_id, provider)
);

create index if not exists integrations_tenant_idx on integrations (tenant_id);

drop trigger if exists integrations_set_updated_at on integrations;
create trigger integrations_set_updated_at
before update on integrations
for each row execute function set_updated_at();
