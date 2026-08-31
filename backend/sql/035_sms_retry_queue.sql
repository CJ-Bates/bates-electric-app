-- 035_sms_retry_queue.sql
-- Queue-and-sweep for customer texts that get refused for a TRANSIENT reason
-- (quiet hours, SMS_ENABLED kill-switch, provider failure). Generalizes the
-- Phase 3 nudge's queued_at/sent_at pattern (sql/027) to the two message
-- kinds that had no redelivery at all:
--
--   1. Booking/reschedule confirmations (routes/generator-care/visits.js):
--      fired once, fire-and-forget, at whatever moment the office books. A
--      booking at 7:58am — two minutes before the quiet-hours window opens —
--      was refused and never retried, so the customer never heard about
--      their appointment (seen live 2026-08-31, Kenneth Arnsmeyer).
--        booking_confirm_queued_at — stamped by the office schedule endpoint
--          the moment a visit is (re)booked for a customer with a phone,
--          BEFORE the send is attempted. A reschedule re-arms: queued_at is
--          reset and sent_at cleared, because a new slot owes a new text.
--        booking_confirm_sent_at — stamped only on a TERMINAL sendSms result
--          ('sent', or the permanent refusals no_consent/opted_out/
--          invalid_phone). Queued-but-unsent visits are retried by the
--          sms-reminders cron sweep (runBookingConfirmRetryPass); a visit
--          whose appointment day has already passed is dropped as stale with
--          a 'stale' row in generator_sms_messages, never sent late.
--
--   2. Appointment reminders (generator-care-cron.js): the daily passes
--      select by TARGET DATE (appointment 3 days out / today), so a visit
--      refused transiently on its target day was never selected again — the
--      "retries next run" comment was theoretical.
--        sms_reminder_3day_queued_at / sms_reminder_dayof_queued_at —
--          stamped by the daily pass when it attempts a visit's reminder.
--          The retry sweep re-selects queued-but-unsent visits regardless of
--          date, then applies the staleness rule in code (retry while the
--          reminder is still meaningful, drop with a logged reason once it
--          isn't, re-arm if the appointment was rescheduled).
--      The existing sms_reminder_3day_at / sms_reminder_dayof_at columns
--      (sql/026) remain the sent/terminal stamps.
--
-- Purely additive; safe to run before or after the code deploys (the code
-- degrades loudly-but-harmlessly if the columns are missing: sends behave as
-- before 035, queue stamps fail to console + Sentry).
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('035_sms_retry_queue.sql') on conflict do nothing;
--
-- VERIFY after running (expected: retry_columns=4):
--   select count(*) as retry_columns
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'generator_service_visits'
--      and column_name in ('booking_confirm_queued_at', 'booking_confirm_sent_at',
--                          'sms_reminder_3day_queued_at', 'sms_reminder_dayof_queued_at');

alter table public.generator_service_visits
  add column if not exists booking_confirm_queued_at    timestamptz,
  add column if not exists booking_confirm_sent_at      timestamptz,
  add column if not exists sms_reminder_3day_queued_at  timestamptz,
  add column if not exists sms_reminder_dayof_queued_at timestamptz;
