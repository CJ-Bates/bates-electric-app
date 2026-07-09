-- 021_generator_leads.sql
-- Growth Engine WP1: the Leads pipeline foundation. One table where every
-- future lead lands — field enrollment, referrals, campaigns, and manual
-- office entry — and gets worked through New -> Contacted -> Signup sent ->
-- Converted (or Lost) from the office dashboard's Leads tab.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('021_generator_leads.sql') on conflict do nothing;
--
-- VERIFY after running (expected: table_exists=1, checks=2, rls_enabled=1,
-- client_grants=0, rows=0):
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name = 'generator_leads') as table_exists,
--     (select count(*) from information_schema.table_constraints
--        where table_schema = 'public' and table_name = 'generator_leads'
--          and constraint_name in ('generator_leads_source_check', 'generator_leads_status_check')) as checks,
--     (select relrowsecurity::int from pg_class
--        where oid = 'public.generator_leads'::regclass) as rls_enabled,
--     (select count(*) from information_schema.role_table_grants
--        where table_schema = 'public' and table_name = 'generator_leads'
--          and grantee in ('anon', 'authenticated')) as client_grants,
--     (select count(*) from public.generator_leads) as rows;
--
-- What this does:
--   1. generator_leads: one row per prospective customer. `source` says which
--      channel produced it (field/referral/campaign/manual); `referred_by_label`
--      carries a human-readable provenance string (tech name, "Referral: Jane
--      Doe", campaign name) so the UI never joins to display who sent it;
--      `referred_by_user_id` keeps the machine link to the staff profile when
--      one exists. `converted_subscription_id` is set when the lead becomes a
--      paying customer (the field-enrollment WP wires the actual signup).
--   2. Internal/office-only posture: RLS enabled with NO policies and an
--      explicit revoke from anon/authenticated — all access goes through the
--      backend service role behind requireAuth + requireRole('office'), same
--      as schema_migrations (020). No column grants: customers and techs have
--      no reason to read leads via PostgREST.

-- ============================================================================
-- 1. Table
-- ============================================================================
create table if not exists public.generator_leads (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null default 'new',
  customer_name text,
  customer_email text,
  customer_phone text,
  install_address text,
  install_city text,
  install_state text,
  install_zip text,
  generator_info text,
  referred_by_user_id uuid references public.profiles(id),
  referred_by_label text,
  notes text,
  converted_subscription_id uuid references public.generator_subscriptions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.generator_leads
    add constraint generator_leads_source_check
    check (source in ('field', 'referral', 'campaign', 'manual'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.generator_leads
    add constraint generator_leads_status_check
    check (status in ('new', 'contacted', 'signup_sent', 'converted', 'lost'));
exception when duplicate_object then null; end $$;

-- The pipeline view filters by stage; the list orders newest-first.
create index if not exists generator_leads_status_idx
  on public.generator_leads (status);
create index if not exists generator_leads_created_at_idx
  on public.generator_leads (created_at desc);

-- ============================================================================
-- 2. Lock it down — office-only via the backend service role. RLS on with no
--    policies + explicit revoke, so direct PostgREST access from any client
--    JWT (customer, tech, or office) reads/writes nothing.
-- ============================================================================
alter table public.generator_leads enable row level security;
revoke all on public.generator_leads from anon, authenticated;
