-- 038_texting_improvements.sql
-- Five texting improvements (spec claude-code-texting-improvements.md):
--   1. Tech "On my way" / "Running late" ETA texts - en-route time, ETA,
--      who sent it, and the late flag + reason on the visit.
--   2. Final reminder the EVENING BEFORE (~6 PM Central) instead of the
--      morning of - its own queue/sent stamps, same 035 queue-and-sweep
--      pattern. The morning-of columns (026/035) stay in place but the
--      morning-of pass is retired in code; nothing is dropped.
--   3. Unconfirmed visits flagged to the office - "Mark confirmed (by
--      phone)" stamp, the office-side twin of sms_confirmed_at (025).
--   4. Review request the day after a completed visit - a terminal stamp
--      + outcome on the visit ('sent' or the skip reason, so the thread and
--      the office can see WHY one did not go), and the customer-level
--      "last requested" date that enforces the 12-month rule.
--   5. After-hours holding reply - no schema.
-- The "system note" rows (running late) use generator_sms_messages.status =
-- 'note' - a free-text column, no constraint to change.
--
-- Purely additive, all nullable. APPLY BEFORE THE CODE DEPLOYS (the usual
-- apply-before-merge rule): the reminder cron, the tech/office ETA routes,
-- the attention queue and the review pass all read these columns.
-- Run manually in the Supabase SQL Editor (idempotent - safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('038_texting_improvements.sql') on conflict do nothing;
--
-- VERIFY after running (expected: visit_columns=11, customer_columns=1,
-- late_reason_check=1, fks=2):
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_service_visits'
--          and column_name in ('en_route_at', 'eta_at', 'eta_sent_by', 'running_late_at', 'late_reason',
--                              'sms_reminder_eve_queued_at', 'sms_reminder_eve_at',
--                              'phone_confirmed_at', 'phone_confirmed_by',
--                              'review_request_at', 'review_request_outcome')) as visit_columns,
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_customers'
--          and column_name = 'last_review_request_at') as customer_columns,
--     (select count(*) from pg_constraint where conname = 'generator_service_visits_late_reason_check') as late_reason_check,
--     (select count(*) from pg_constraint
--        where conname in ('generator_service_visits_eta_sent_by_fkey', 'generator_service_visits_phone_confirmed_by_fkey')) as fks;

-- ============================================================================
-- 1. ETA texts (On my way / Running late)
-- ============================================================================
alter table public.generator_service_visits
  add column if not exists en_route_at     timestamptz,  -- when "On my way" was sent
  add column if not exists eta_at          timestamptz,  -- the latest ETA texted to the customer
  add column if not exists eta_sent_by     uuid,         -- profile who sent the latest ETA text (tech or office)
  add column if not exists running_late_at timestamptz,  -- when "Running late" was sent (also blocks the review request)
  add column if not exists late_reason     text;         -- 'traffic' | 'previous_job' | 'other' (office-facing only)

do $$ begin
  alter table public.generator_service_visits
    add constraint generator_service_visits_eta_sent_by_fkey
    foreign key (eta_sent_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.generator_service_visits
    add constraint generator_service_visits_late_reason_check
    check (late_reason is null or late_reason in ('traffic', 'previous_job', 'other'));
exception when duplicate_object then null; end $$;

-- ============================================================================
-- 2. Evening-before reminder (replaces the morning-of pass)
-- ============================================================================
alter table public.generator_service_visits
  add column if not exists sms_reminder_eve_queued_at timestamptz,  -- "this visit was owed the evening reminder"
  add column if not exists sms_reminder_eve_at        timestamptz;  -- terminal: sent, permanent refusal, or stale/skipped

-- ============================================================================
-- 3. Confirmed by phone (office)
-- ============================================================================
alter table public.generator_service_visits
  add column if not exists phone_confirmed_at timestamptz,
  add column if not exists phone_confirmed_by uuid;

do $$ begin
  alter table public.generator_service_visits
    add constraint generator_service_visits_phone_confirmed_by_fkey
    foreign key (phone_confirmed_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ============================================================================
-- 4. Review request after the visit
-- ============================================================================
alter table public.generator_service_visits
  add column if not exists review_request_at      timestamptz,  -- terminal stamp: the pass will not look at this visit again
  add column if not exists review_request_outcome text;         -- 'sent' | 'skipped: <reason>'

alter table public.generator_customers
  add column if not exists last_review_request_at timestamptz;  -- 12-month rule

-- Review pass selects completed visits with no stamp; keep that cheap.
create index if not exists generator_visits_review_pending_idx
  on public.generator_service_visits (completed_date)
  where status = 'completed' and review_request_at is null;
