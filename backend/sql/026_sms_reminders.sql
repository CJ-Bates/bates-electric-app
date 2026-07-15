-- 026_sms_reminders.sql
-- SMS Phase 2: appointment-reminder idempotency stamps.
-- Two additive columns on generator_service_visits, one per reminder pass
-- (3 days before / morning of). The daily cron stamps a column when that
-- reminder reaches a TERMINAL result (sent, or a permanent refusal like
-- no_consent) and only ever selects visits where the column is still null —
-- that pair is what makes an occasional double-fired cron harmless.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('026_sms_reminders.sql') on conflict do nothing;
--
-- VERIFY after running (expected: reminder_columns=2):
--   select count(*) as reminder_columns
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'generator_service_visits'
--      and column_name in ('sms_reminder_3day_at', 'sms_reminder_dayof_at');

alter table public.generator_service_visits
  add column if not exists sms_reminder_3day_at  timestamptz,
  add column if not exists sms_reminder_dayof_at timestamptz;
