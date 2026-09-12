-- =============================================================================
-- Vexora AI - Organizations (B2B teams + B2C personal workspaces)
-- =============================================================================
-- The tenant stops being a USER and becomes an ORGANIZATION.
--
-- Every user belongs to exactly one organization, including B2C: a personal
-- signup silently creates a `type='personal'` org with that user as its admin.
-- That keeps ONE code path -- tenant_id is always an organization id, with no
-- B2C branching anywhere in the data layer.
--
-- BACKFILL STRATEGY: existing organizations reuse the founding user's UUID.
-- Every existing tenant_id / sales_rep_id already equals a users.id, so making
-- organizations.id = users.id keeps every existing row valid with ZERO data
-- rewriting. This matters most for the vector store, where tenant isolation is
-- metadata-based (documents.service writes `tenantId` into vector metadata) and
-- no code path exists that can rewrite that metadata in place.
--
-- Idempotent: safe to run multiple times.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- organizations: one row per workspace (a company, or one person's own space)
-- -----------------------------------------------------------------------------
create table if not exists organizations (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  -- 'business' = created via org signup; 'personal' = a B2C workspace.
  -- Informational only: what actually gates team size is seat_limit, so a
  -- personal workspace becomes a team the moment we raise its seats.
  type                text        not null default 'business',
  -- 'suspended' blocks every member from using the app (unpaid account).
  status              text        not null default 'active',
  -- Seats INCLUDE the admin. Defaults to 1 (admin only); the platform admin
  -- raises it to match what the client has paid for.
  seat_limit          integer     not null default 1,
  -- The identity the chatbot presents to customers (moved off `users`).
  company_name        text,
  company_description text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint organizations_type_chk   check (type in ('business', 'personal')),
  constraint organizations_status_chk check (status in ('active', 'suspended')),
  constraint organizations_seats_chk  check (seat_limit >= 1)
);

-- -----------------------------------------------------------------------------
-- organization_members: which users belong to which organization, and their
-- role INSIDE it ('admin' manages keys + users; 'member' just works there).
-- -----------------------------------------------------------------------------
create table if not exists organization_members (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  user_id         uuid        not null references users(id) on delete cascade,
  role            text        not null default 'member',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organization_members_role_chk check (role in ('admin', 'member')),
  -- ONE org per user for now. The mapping-table shape keeps multi-org
  -- membership open later without reshaping anything.
  constraint organization_members_user_uniq unique (user_id)
);

create index if not exists organization_members_org_idx
  on organization_members (organization_id);

-- -----------------------------------------------------------------------------
-- users.role becomes PLATFORM-level only ('platform_admin' = Vexora staff).
-- The org-level role lives on organization_members.role.
-- -----------------------------------------------------------------------------
alter table users drop constraint if exists users_role_chk;
update users set role = 'platform_admin' where role = 'admin';
alter table users add constraint users_role_chk
  check (role in ('user', 'platform_admin'));

-- -----------------------------------------------------------------------------
-- Backfill: one personal org per existing user, REUSING the user's uuid.
-- -----------------------------------------------------------------------------
insert into organizations (id, name, type, seat_limit, company_name, company_description)
select u.id,
       coalesce(nullif(trim(u.company_name), ''), u.name || '''s workspace'),
       'personal',
       1,
       u.company_name,
       u.company_description
  from users u
 where not exists (select 1 from organizations o where o.id = u.id);

insert into organization_members (organization_id, user_id, role)
select u.id, u.id, 'admin'
  from users u
 where not exists (select 1 from organization_members m where m.user_id = u.id);

-- The company profile now lives on the organization only (copied above), so
-- there is exactly one source of truth for the chatbot's identity.
alter table users drop column if exists company_name;
alter table users drop column if exists company_description;

-- -----------------------------------------------------------------------------
-- Keep updated_at fresh (set_updated_at() is created in 001_init.sql)
-- -----------------------------------------------------------------------------
drop trigger if exists organizations_set_updated_at on organizations;
create trigger organizations_set_updated_at
before update on organizations
for each row execute function set_updated_at();

drop trigger if exists organization_members_set_updated_at on organization_members;
create trigger organization_members_set_updated_at
before update on organization_members
for each row execute function set_updated_at();
