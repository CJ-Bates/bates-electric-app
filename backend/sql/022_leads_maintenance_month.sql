-- 022_leads_maintenance_month.sql
-- Growth Engine WP3: columns for the maintenance-book import. Bates's ~1,650
-- existing generator-maintenance customers come in as source='campaign' leads
-- (scripts/import-maintenance-leads.js), each tagged with the month their
-- maintenance is due so the Leads tab can group them into monthly cohorts and
-- WP4 can drip signup invites cohort by cohort.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('022_leads_maintenance_month.sql') on conflict do nothing;
--
-- VERIFY after running (expected: columns=3, month_index=1):
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_leads'
--          and column_name in ('maintenance_month', 'import_batch', 'contact_type')) as columns,
--     (select count(*) from pg_indexes
--        where schemaname = 'public' and tablename = 'generator_leads'
--          and indexname = 'generator_leads_maintenance_month_idx') as month_index;
--
-- What this adds to generator_leads (all additive — no existing rows change):
--   maintenance_month  3-letter month ('Jan'..'Dec') the customer's maintenance
--                      is due, or null (manual/field/referral leads don't have
--                      one). Text rather than a date: the book is organized by
--                      calendar month, not a specific day.
--   import_batch       tag stamped on every row of a bulk import (e.g.
--                      'gen-maint-2026-07') so a campaign import is
--                      identifiable — and reversible — as a group.
--   contact_type       'Person' / 'Couple' / 'Business' from the book; drives
--                      greeting style and whether outreach personalizes.

alter table public.generator_leads
  add column if not exists maintenance_month text;
alter table public.generator_leads
  add column if not exists import_batch text;
alter table public.generator_leads
  add column if not exists contact_type text;

-- Belt-and-suspenders on the month values — the import script validates too,
-- but a typo'd month from any future writer would silently break the cohort
-- grouping in the Leads tab.
do $$ begin
  alter table public.generator_leads
    add constraint generator_leads_maintenance_month_check
    check (maintenance_month is null or maintenance_month in
      ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'));
exception when duplicate_object then null; end $$;

-- The Leads tab filters cohorts by month server-side (?maintenance_month=).
create index if not exists generator_leads_maintenance_month_idx
  on public.generator_leads (maintenance_month);
