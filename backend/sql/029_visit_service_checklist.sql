-- 029_visit_service_checklist.sql
-- Tech-side interactive service checklist: per-visit record of which included
-- plan services the tech actually performed. Stores the SET OF COMPLETED ITEM
-- LABELS (the exact strings from PLAN_VISIT_ITEMS in lib/generator-catalog.js)
-- as a jsonb array — label-based, not index-based, so adding/reordering the
-- catalog list later never corrupts old records; readers just intersect the
-- stored labels with the current list. Tech-side only for now; the customer
-- and office surfaces can read this later without another migration.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('029_visit_service_checklist.sql') on conflict do nothing;
--
-- VERIFY after running (expected: checklist_column=1, all rows default '[]'):
--   select count(*) as checklist_column
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'generator_service_visits'
--      and column_name = 'completed_checklist';
--   select count(*) as non_array_rows
--     from public.generator_service_visits
--    where jsonb_typeof(completed_checklist) is distinct from 'array';
--   -- expected: non_array_rows=0

alter table public.generator_service_visits
  add column if not exists completed_checklist jsonb not null default '[]'::jsonb;
