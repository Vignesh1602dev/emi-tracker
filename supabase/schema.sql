-- Run this once in Supabase: SQL Editor > New query > paste > Run
create extension if not exists pgcrypto;

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  username text not null,
  pass_hash text not null,
  salt text not null,
  role text not null check (role in ('Admin','Staff')),
  created_at timestamptz not null default now()
);
create unique index if not exists app_users_username_key on app_users (username);

create table if not exists customers (
  org_id uuid not null references orgs(id) on delete cascade,
  id bigint not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table if not exists payments (
  org_id uuid not null references orgs(id) on delete cascade,
  rid text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (org_id, rid)
);

create table if not exists settings (
  org_id uuid not null references orgs(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

-- Security: block all direct access. Only the Cloudflare Worker (service_role key) can read/write.
alter table orgs enable row level security;
alter table app_users enable row level security;
alter table customers enable row level security;
alter table payments enable row level security;
alter table settings enable row level security;
revoke all on orgs, app_users, customers, payments, settings from anon, authenticated;

-- customer photo / Aadhaar / PAN images
create table if not exists customer_docs (
  org_id uuid not null references orgs(id) on delete cascade,
  cid bigint not null,
  kind text not null check (kind in ('photo','aadhaar','pan')),
  data text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, cid, kind)
);
alter table customer_docs enable row level security;
revoke all on customer_docs from anon, authenticated;
