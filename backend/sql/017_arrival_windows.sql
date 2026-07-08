-- 017_arrival_windows.sql
-- Arrival-window scheduling (app-wide). Run manually in the Supabase SQL
-- Editor (idempotent).
--
-- Amy books generator visits in 2-hour ARRIVAL WINDOWS (7-9, 8-10, 10-12,
-- 12-2, and sometimes 1-3), not exact clock times. This adds the
-- human-facing window label to each visit:
--
--   arrival_window text  -- window code, e.g. '8-10'. NULL = legacy/unset
--                        -- visit (displays fall back to the stored time).
--
-- appointment_at STAYS the machine key: booking sets it to the window's
-- START time on the booked date, so sorting, the Scheduled/Needs-scheduling
-- state, grid-anchoring, and digest logic keep working unchanged.
--
-- The window list itself (codes, labels, start times) is NOT constrained
-- here on purpose - it lives in ONE editable place per deploy target:
-- backend/lib/generator-catalog.js (ARRIVAL_WINDOWS) mirrored by
-- frontend/arrival-windows.js. A DB CHECK would mean a migration every time
-- Amy's window list changes.
--
-- VERIFY after running (expected: column_exists=1, with_window=0 on first
-- run - no visit has a window yet - and total_visits = your current count):
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public'
--          and table_name  = 'generator_service_visits'
--          and column_name = 'arrival_window') as column_exists,
--     (select count(*) from public.generator_service_visits) as total_visits,
--     (select count(*) from public.generator_service_visits
--        where arrival_window is not null) as with_window;

ALTER TABLE public.generator_service_visits
  ADD COLUMN IF NOT EXISTS arrival_window text; -- window code ('7-9','8-10','10-12','12-2','1-3'); NULL = legacy/unset

-- Customers may read their own visits directly via PostgREST (011's RLS +
-- column grants). The window is customer-safe display data - add it to the
-- granted column list (additive; 011's grant statement stays as-is).
GRANT SELECT (arrival_window) ON public.generator_service_visits TO authenticated;
