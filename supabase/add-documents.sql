-- Run this ONCE in Supabase SQL Editor if you already deployed before (adds customer photo / Aadhaar / PAN storage)
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
