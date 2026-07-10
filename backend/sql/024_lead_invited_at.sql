-- 024_lead_invited_at.sql
-- Growth Engine WP4.2: "Needs follow-up" surfacing for invited leads.
-- A lead that got the enrollment invite but hasn't signed up after ~3 weeks
-- shouldn't be auto-marked Lost (they're existing maintenance customers worth
-- a nudge) — the Leads tab just flags them. The flag is DERIVED, no cron and
-- no status change: status = 'signup_sent' AND invited_at older than the
-- follow-up window (21 days, a named constant in frontend/leads.js).
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('024_lead_invited_at.sql') on conflict do nothing;
--
-- VERIFY after running (expected: columns=1, unstamped_signup_sent=0):
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_leads'
--          and column_name = 'invited_at') as columns,
--     (select count(*) from public.generator_leads
--        where status = 'signup_sent' and invited_at is null) as unstamped_signup_sent;
--
-- What this adds to generator_leads (additive — no columns change or drop):
--   invited_at  when the signup invite was last sent. Stamped by BOTH send
--               paths (the batch send-invites and the per-lead send-signup)
--               whenever a lead advances to signup_sent; a re-send re-stamps
--               it, which deliberately resets the follow-up clock.
--
-- The backfill gives already-invited leads a best-effort invited_at from
-- updated_at: for a signup_sent lead, updated_at was last touched by the
-- send that advanced it (sends are the only writers that move a lead to
-- signup_sent), so the flag works for the existing pipeline immediately
-- instead of only for leads invited after this deploy.

alter table public.generator_leads
  add column if not exists invited_at timestamptz;

update public.generator_leads
  set invited_at = updated_at
  where status = 'signup_sent' and invited_at is null;
