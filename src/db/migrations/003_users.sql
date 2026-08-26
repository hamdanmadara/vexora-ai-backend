-- =============================================================================
-- Vexora AI - Multi-user authentication
-- =============================================================================
-- One user = one workspace (tenant). The user's uuid (as text) becomes the
-- tenant_id on documents/leads/analytics_reports and the sales_rep_id on
-- google_credentials/meetings, so the existing tenant columns from 001/002
-- carry user scoping without any reshaping.
-- Idempotent: safe to run multiple times.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users: one row per account (= one workspace/tenant)
-- -----------------------------------------------------------------------------
create table if not exists users (
  id                   uuid        primary key default gen_random_uuid(),
  email                text        not null unique,
  password_hash        text        not null,
  name                 text        not null,
  -- 'user' = a workspace owner; 'admin' = platform operator (admin mode).
  -- Signup only ever creates 'user' — admins are promoted manually:
  --   update users set role = 'admin' where email = '...';
  role                 text        not null default 'user',
  -- Company profile: what the chatbot tells customers it represents.
  company_name         text,
  company_description  text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint users_email_lower_chk check (email = lower(email)),
  constraint users_role_chk check (role in ('user', 'admin'))
);

-- -----------------------------------------------------------------------------
-- refresh_tokens: long-lived session tokens, stored hashed, rotated on use
-- -----------------------------------------------------------------------------
create table if not exists refresh_tokens (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  token_hash   text        not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists refresh_tokens_user_idx on refresh_tokens (user_id);
-- Expired/revoked rows are pruned opportunistically on refresh.
create index if not exists refresh_tokens_expiry_idx on refresh_tokens (expires_at);

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();
