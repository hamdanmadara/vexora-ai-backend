-- =============================================================================
-- Vexora AI - Initial schema
-- =============================================================================
-- Idempotent: safe to run multiple times.
-- All Mastra-managed tables (mastra_threads, mastra_messages, mastra_vectors)
-- are created by Mastra itself, not here.
-- =============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- documents: one row per uploaded file
-- -----------------------------------------------------------------------------
create table if not exists documents (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       text        not null default 'default',
  name            text        not null,
  mime_type       text        not null,
  size_bytes      bigint      not null,
  status          text        not null default 'queued',
  chunk_count     integer     not null default 0,
  char_count      integer     not null default 0,
  error           text,
  uploaded_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint documents_status_chk check (
    status in ('queued','processing','ready','failed')
  )
);

create index if not exists documents_tenant_idx on documents (tenant_id, uploaded_at desc);

-- -----------------------------------------------------------------------------
-- leads: a person we are chatting with
-- -----------------------------------------------------------------------------
create table if not exists leads (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       text        not null default 'default',
  session_id      text        not null unique,  -- chat thread id
  name            text,
  email           text,
  channel         text        not null default 'web',
  status          text        not null default 'new',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint leads_status_chk check (
    status in ('new','engaged','collecting_info','meeting_proposed','meeting_booked','closed')
  )
);

create index if not exists leads_tenant_idx on leads (tenant_id, updated_at desc);
create index if not exists leads_email_idx on leads (email) where email is not null;

-- -----------------------------------------------------------------------------
-- google_credentials: one row per sales rep
-- -----------------------------------------------------------------------------
create table if not exists google_credentials (
  sales_rep_id    text        primary key,
  access_token    text,
  refresh_token   text        not null,
  expiry_date     bigint,
  scope           text,
  token_type      text,
  google_email    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- meetings: a meeting that the AI booked
-- -----------------------------------------------------------------------------
create table if not exists meetings (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid        references leads(id) on delete set null,
  sales_rep_id    text        not null,
  provider        text        not null default 'google_meet',
  event_id        text,
  meet_link       text,
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  attendee_email  text        not null,
  attendee_name   text,
  status          text        not null default 'scheduled',
  created_at      timestamptz not null default now()
);

create index if not exists meetings_lead_idx on meetings (lead_id);
create index if not exists meetings_rep_idx on meetings (sales_rep_id, start_time);

-- -----------------------------------------------------------------------------
-- Convenience: keep updated_at fresh
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists documents_set_updated_at on documents;
create trigger documents_set_updated_at
before update on documents
for each row execute function set_updated_at();

drop trigger if exists leads_set_updated_at on leads;
create trigger leads_set_updated_at
before update on leads
for each row execute function set_updated_at();

drop trigger if exists google_credentials_set_updated_at on google_credentials;
create trigger google_credentials_set_updated_at
before update on google_credentials
for each row execute function set_updated_at();
