-- 025_sms_phase1.sql
-- SMS Phase 1 (SimpleTexting): two-way appointment-confirmation texts.
-- Three additive pieces: the consent ledger (the legal record of every
-- opt-in/opt-out), the message log (every text in or out), and a
-- confirmation stamp on the visit ("customer replied Y").
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('025_sms_phase1.sql') on conflict do nothing;
--
-- VERIFY after running (expected: consent_table=1, messages_table=1,
-- visit_column=1, rls_enabled=2, client_grants=0, consent_rows=0):
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name = 'generator_sms_consent') as consent_table,
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name = 'generator_sms_messages') as messages_table,
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_service_visits'
--          and column_name = 'sms_confirmed_at') as visit_column,
--     (select count(*) from pg_class
--        where oid in ('public.generator_sms_consent'::regclass, 'public.generator_sms_messages'::regclass)
--          and relrowsecurity) as rls_enabled,
--     (select count(*) from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name in ('generator_sms_consent', 'generator_sms_messages')
--          and grantee in ('anon', 'authenticated')) as client_grants,
--     (select count(*) from public.generator_sms_consent) as consent_rows;
--
-- What this does:
--   1. generator_sms_consent: one row per (customer, phone). THE LEGAL RECORD —
--      rows are never deleted; opt-in/opt-out flip the flags and stamp the
--      timestamps. consent_text stores the EXACT language the customer saw
--      (TCPA/A2P evidence). source says which path captured it.
--   2. generator_sms_messages: log of every message, both directions. Outbound
--      rows are written even when the send is refused (kill-switch off, no
--      consent, quiet hours) with a status saying why — that's how the office
--      sees "would have sent" during testing and "blocked" in production.
--      NEVER log the API token here (lib/sms.js enforces that).
--   3. generator_service_visits.sms_confirmed_at: stamped when the customer
--      replies Y to the booking-confirmation text; cleared on re-book so a
--      rescheduled visit asks again.
--   4. Internal/office-only posture for both tables: RLS enabled with NO
--      policies and an explicit revoke from anon/authenticated — all access
--      goes through the backend service role (same as 020/021).

-- ============================================================================
-- 1. Consent ledger
-- ============================================================================
create table if not exists public.generator_sms_consent (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.generator_customers(id),
  phone text not null,               -- E.164 (+1XXXXXXXXXX); lib/sms.js normalizes
  opted_in boolean not null default false,
  opted_out boolean not null default false,
  source text not null,              -- which path captured the consent
  consent_text text,                 -- the exact language shown/read to the customer
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, phone)
);

do $$ begin
  alter table public.generator_sms_consent
    add constraint generator_sms_consent_source_check
    check (source in ('signup', 'dashboard', 'office', 'import', 'sms'));
exception when duplicate_object then null; end $$;

-- Inbound webhook matches the sender's number to a consent row.
create index if not exists generator_sms_consent_phone_idx
  on public.generator_sms_consent (phone);

-- ============================================================================
-- 2. Message log
-- ============================================================================
create table if not exists public.generator_sms_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null,           -- 'out' | 'in'
  to_phone text,                     -- E.164; outbound: the customer, inbound: our number
  from_phone text,                   -- E.164; outbound: our number, inbound: the customer
  body text not null,
  provider_id text,                  -- SimpleTexting message id, when we got one
  status text not null,              -- out: sent|failed|disabled|no_consent|opted_out|quiet_hours|invalid_phone; in: received
  detail text,                       -- failure reason / parse note (never the API token)
  customer_id uuid references public.generator_customers(id) on delete set null,
  related_visit_id uuid references public.generator_service_visits(id) on delete set null,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.generator_sms_messages
    add constraint generator_sms_messages_direction_check
    check (direction in ('out', 'in'));
exception when duplicate_object then null; end $$;

-- Office visit view shows the latest outbound per visit; inbound matching
-- and the customer thread both read by phone/customer.
create index if not exists generator_sms_messages_visit_idx
  on public.generator_sms_messages (related_visit_id);
create index if not exists generator_sms_messages_customer_idx
  on public.generator_sms_messages (customer_id, created_at desc);

-- ============================================================================
-- 3. Visit confirmation stamp
-- ============================================================================
alter table public.generator_service_visits
  add column if not exists sms_confirmed_at timestamptz;

-- ============================================================================
-- 4. Lock both tables down — backend service role only (same as 020/021).
-- ============================================================================
alter table public.generator_sms_consent enable row level security;
revoke all on public.generator_sms_consent from anon, authenticated;
alter table public.generator_sms_messages enable row level security;
revoke all on public.generator_sms_messages from anon, authenticated;
