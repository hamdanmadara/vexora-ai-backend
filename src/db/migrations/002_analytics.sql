-- =============================================================================
-- Vexora AI - Analytics reports
-- =============================================================================
-- One row per tenant per calendar month. Stores the AI-generated report AND a
-- snapshot of the deterministic metrics as they stood at generation time, so a
-- saved report stays internally consistent even as new conversations land, and
-- re-opening an old month costs nothing.
-- =============================================================================

create table if not exists analytics_reports (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          text        not null default 'default',
  -- Calendar month this report covers, as 'YYYY-MM'.
  period             text        not null,
  status             text        not null default 'ready',
  model              text,
  -- Structured AI output (summary, topics, knowledge gaps, actions, ...).
  insights           jsonb       not null default '{}'::jsonb,
  -- The SQL metrics at generation time — keeps the report self-contained.
  metrics_snapshot   jsonb       not null default '{}'::jsonb,
  conversation_count integer     not null default 0,
  message_count      integer     not null default 0,
  error              text,
  generated_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint analytics_reports_status_chk check (
    status in ('generating','ready','failed')
  ),
  constraint analytics_reports_period_chk check (period ~ '^\d{4}-\d{2}$'),
  constraint analytics_reports_unique unique (tenant_id, period)
);

create index if not exists analytics_reports_tenant_idx
  on analytics_reports (tenant_id, period desc);

drop trigger if exists analytics_reports_set_updated_at on analytics_reports;
create trigger analytics_reports_set_updated_at
before update on analytics_reports
for each row execute function set_updated_at();
