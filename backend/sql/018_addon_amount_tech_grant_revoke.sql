-- 018_addon_amount_tech_grant_revoke.sql
-- WP4 / H2 — tighten the direct-REST column grant on generator_pending_addons.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- Background: 011's column-level grant on generator_pending_addons included
-- amount_cents in the SELECT allowlist for the shared `authenticated` Postgres
-- role. Tech and customer are the SAME db role, so a tech's JWT + the public
-- anon key can query PostgREST directly —
--     GET /rest/v1/generator_pending_addons?select=amount_cents&subscription_id=eq.<id>
-- and read add-on dollar amounts, even though the tech HTTP API deliberately
-- strips them (routes/generator-tech.js techAddonShape returns no amounts).
--
-- Safe to remove because nothing reads amount_cents via direct REST: the
-- customer dashboard (/api/my/*) and office dashboard (/api/generator-care/*)
-- both read add-ons through the backend SERVICE ROLE (supabaseAdmin), which
-- bypasses column grants entirely. The only direct-REST calls in the frontend
-- are the two visit-photo row INSERTs (tech.js, inspection.js) — neither touches
-- this table. So this grant change does NOT affect any app surface.
--
-- Mechanics note: column-level SELECT privileges live in pg_attribute.attacl,
-- SEPARATELY from table-level privileges in pg_class.relacl. A plain
-- `revoke select on <table>` clears only the table-level grant and would leave
-- the amount_cents column grant untouched — so the targeted column revoke on
-- line "2." below is the load-bearing statement, not the table-level revoke.

-- 1. Strip any table-level SELECT (defensive). 011 already reduced this role to
--    column grants only, but this guarantees amount_cents can't be reached via
--    a stray table-wide grant re-added elsewhere.
revoke select on public.generator_pending_addons from authenticated;

-- 2. THE FIX: remove the column-level SELECT on amount_cents.
revoke select (amount_cents) on public.generator_pending_addons from authenticated;

-- 3. Re-affirm the exact customer/tech-safe allowlist a direct-REST reader may
--    see (idempotent; amount_cents deliberately absent). Everything else on the
--    table — stripe_price_id, stripe_invoice_item_id, stripe_payment_intent_id,
--    date_charged, notes, updated_at, performed_by, service_visit_id — was
--    already excluded by 011 and stays service-role-only.
grant select (id, subscription_id, addon_type, status, date_performed, created_at)
  on public.generator_pending_addons to authenticated;

-- ============================================================================
-- VERIFICATION (run after the grant statements above; not part of the change)
-- ============================================================================
-- (a) Full allowlist for grantee 'authenticated' — expect EXACTLY these 6 rows
--     and NO amount_cents:
--        addon_type, created_at, date_performed, id, status, subscription_id
select column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'generator_pending_addons'
  and grantee = 'authenticated'
order by column_name;

-- (b) Focused assertion — amount_cents must return ZERO rows:
select column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'generator_pending_addons'
  and grantee = 'authenticated'
  and column_name = 'amount_cents';
