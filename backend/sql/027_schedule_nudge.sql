-- 027_schedule_nudge.sql
-- SMS Phase 3: "time to schedule" nudge — queue marker + idempotency stamp.
-- Two additive columns on generator_service_visits:
--
--   schedule_nudge_queued_at — set by the invoice.upcoming webhook the moment
--     it decides this cycle's open visit should get a nudge (before the send
--     is attempted). invoice.upcoming fires ONCE per cycle at whatever hour
--     Stripe picks, so a send refused by quiet hours or the SMS_ENABLED
--     kill-switch can't rely on event redelivery — the daily 8am sms-reminders
--     cron sweeps visits that are queued but not yet sent and retries them.
--
--   schedule_nudge_sent_at — stamped when the nudge reaches a TERMINAL send
--     result (sent, or a permanent refusal like no_consent) — the same rule
--     as the 026 reminder stamps. Both the webhook and the cron sweep only
--     act while this is null, so a re-delivered Stripe event or a double-fired
--     cron can never double-nudge.
--
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('027_schedule_nudge.sql') on conflict do nothing;
--
-- VERIFY after running (expected: nudge_columns=2):
--   select count(*) as nudge_columns
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'generator_service_visits'
--      and column_name in ('schedule_nudge_queued_at', 'schedule_nudge_sent_at');

alter table public.generator_service_visits
  add column if not exists schedule_nudge_queued_at timestamptz,
  add column if not exists schedule_nudge_sent_at   timestamptz;
