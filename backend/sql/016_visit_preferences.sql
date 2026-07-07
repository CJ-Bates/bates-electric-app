-- 016_visit_preferences.sql
-- Customer Dashboard v2: appointment preferences. Customers propose up to
-- three date + AM/PM windows for their next open visit from my.html; the
-- office sees them in the customer modal (Service Visits) and books with one
-- tap. Booking the visit marks the pending preferences 'used'.
-- Run manually in the Supabase SQL Editor (idempotent).
--
-- VERIFY after running (expected: table_exists=1, policies=1, rls_enabled=1,
-- rows=0 on a fresh install):
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name = 'generator_visit_preferences') as table_exists,
--     (select count(*) from pg_policies
--        where schemaname = 'public' and tablename = 'generator_visit_preferences') as policies,
--     (select relrowsecurity::int from pg_class
--        where oid = 'public.generator_visit_preferences'::regclass) as rls_enabled,
--     (select count(*) from public.generator_visit_preferences) as rows;
--
-- What this does:
--   1. generator_visit_preferences: one row per customer submission —
--      slots jsonb (up to 3 of {date: 'YYYY-MM-DD', window: 'AM'|'PM'}),
--      optional note, status pending/used/dismissed. Resubmitting replaces:
--      the backend dismisses the old pending row and inserts a fresh one.
--   2. Customer READ policy mirroring the generator_service_visits pattern
--      (email-matched through visit -> subscription -> customer). SELECT only;
--      ALL writes go through the backend service role (no customer/office
--      write policies — same as every other generator_* table).
--   3. Column-level grants for the authenticated role (all columns here are
--      customer-safe, but the revoke/grant pattern matches 011 so future
--      columns default to hidden).

-- ============================================================================
-- 1. Table
-- ============================================================================
create table if not exists public.generator_visit_preferences (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.generator_service_visits(id) on delete cascade,
  slots jsonb not null default '[]'::jsonb,
  note text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.generator_visit_preferences
    add constraint generator_visit_preferences_status_check
    check (status in ('pending', 'used', 'dismissed'));
exception when duplicate_object then null; end $$;

-- The office modal and the customer dashboard both look up pending rows by
-- visit; used/dismissed rows are history.
create index if not exists generator_visit_preferences_visit_status_idx
  on public.generator_visit_preferences (visit_id, status);

-- ============================================================================
-- 2. RLS: customer read-only, writes via backend service role only
-- ============================================================================
alter table public.generator_visit_preferences enable row level security;

drop policy if exists "gen_visit_prefs customer read" on public.generator_visit_preferences;
create policy "gen_visit_prefs customer read"
  on public.generator_visit_preferences for select
  using (
    public.current_role() = 'customer'
    and exists (
      select 1
      from public.generator_service_visits v
      join public.generator_subscriptions s on s.id = v.subscription_id
      join public.generator_customers c on c.id = s.customer_id
      where v.id = visit_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- ============================================================================
-- 3. Column-level grants (mirrors 011's revoke-then-grant pattern)
-- ============================================================================
revoke select on public.generator_visit_preferences from authenticated;
grant select (id, visit_id, slots, note, status, created_at)
  on public.generator_visit_preferences to authenticated;
