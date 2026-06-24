-- 008_visit_appointments.sql
-- Run in the Supabase SQL Editor. Idempotent (safe to re-run).
--
-- Separates a visit's plan-driven DUE date (generator_subscriptions.next_visit_due,
-- auto-managed) from a BOOKED appointment date+time, and adds a scheduling /
-- completion audit trail (who + when), mirroring the Jonas hand-off stamps.
--
-- Visit display state is derived in code:
--   completed_date set            -> Completed
--   appointment_at set (not done) -> Scheduled (shows date + time)
--   otherwise                     -> Needs scheduling (due date shown as context)
-- No status-enum change is needed.

ALTER TABLE public.generator_service_visits
  ADD COLUMN IF NOT EXISTS appointment_at timestamptz, -- booked date+time (NULL = needs scheduling)
  ADD COLUMN IF NOT EXISTS scheduled_by   text,        -- who booked it (office user name/email)
  ADD COLUMN IF NOT EXISTS scheduled_at   timestamptz, -- when it was booked (audit)
  ADD COLUMN IF NOT EXISTS completed_by   text;        -- who marked it complete (audit)

-- Helps the dashboard list pull each subscription's current open (un-completed) visit.
CREATE INDEX IF NOT EXISTS idx_gen_visits_sub_status
  ON public.generator_service_visits (subscription_id, status);
