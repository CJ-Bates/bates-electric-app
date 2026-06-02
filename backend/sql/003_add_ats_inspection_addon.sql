-- Bates Electric - Generator Program
-- Migration 003: Add 'ats_inspection' to the addon_type enum constraint
-- Adds support for Automatic Transfer Switch Inspection add-on ($75).
-- Safe to re-run.

-- Drop existing check constraint and recreate with ats_inspection added.
-- Use dynamic SQL because the constraint name may differ across environments.
do $$
declare
  c_name text;
begin
  select conname into c_name
    from pg_constraint
    where conrelid = 'public.generator_pending_addons'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%addon_type%';

  if c_name is not null then
    execute format('alter table public.generator_pending_addons drop constraint %I', c_name);
  end if;
end$$;

alter table public.generator_pending_addons
  add constraint generator_pending_addons_addon_type_check
  check (addon_type in (
    'battery_diagnostics',
    'battery_replacement',
    'exterior_wash',
    'outage_test',
    'coolant_flush',
    'coolant_topoff',
    'ats_inspection'
  ));
