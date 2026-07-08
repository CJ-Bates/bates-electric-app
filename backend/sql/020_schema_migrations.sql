-- 020_schema_migrations.sql
-- New internal ops table: a ledger of which backend/sql/*.sql files have
-- actually been applied to this database. Run manually in the Supabase SQL
-- Editor (idempotent — safe to re-run).
--
-- Background: migrations here are run by hand in the Supabase SQL editor.
-- Nothing in the DB records which files have actually landed, and drift has
-- bitten us before (a trigger existed live that the repo never had; a couple
-- of migrations shipped partially). This table is the ledger; going forward,
-- after running NNN_*.sql also insert its filename here (see backend/sql/README.md).
--
-- SEED LIST — CJ: please confirm before running. This seeds every file in
-- backend/sql/ EXCEPT 019, on the following basis:
--   - 001 through 018 (16 files) are recorded live per prior session notes
--     (018 in particular was verified live 2026-07-08).
--   - There are TWO files numbered 010 — 010_recurring_addons.sql and
--     010_tech_phase2.sql. Per session notes (013's fix references
--     "011-broke-010" photo policies), both appear to have been applied
--     under their distinct filenames, not just one. Seeding both by filename
--     sidesteps the numeric collision since ids here are full filenames.
--   - 019_visit_photo_path_binding.sql is DELIBERATELY EXCLUDED — written but
--     not yet applied (open loop, deferred per prior session notes).
-- If any of this is wrong (e.g. one of the two 010s was never actually run,
-- or 019 has since been applied), tell the agent before running this file.

-- 1. The ledger table itself.
create table if not exists public.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

-- 2. Lock it down — internal ops table, service role only. No grants to
--    anon/authenticated (default is already no access, but revoke explicitly
--    so this is self-documenting and immune to a future default-grant change).
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;

-- 3. Seed rows for every migration already applied (idempotent).
insert into public.schema_migrations (id) values
  ('001_initial_schema.sql'),
  ('002_generator_schema.sql'),
  ('003_add_ats_inspection_addon.sql'),
  ('004_add_past_due_status.sql'),
  ('005_metrics_capture.sql'),
  ('006_jonas_handoff.sql'),
  ('007_work_order_number.sql'),
  ('008_visit_appointments.sql'),
  ('009_tech_dashboard.sql'),
  ('010_recurring_addons.sql'),
  ('010_tech_phase2.sql'),
  ('011_customer_portal.sql'),
  ('012_customer_signup_gate.sql'),
  ('013_tech_photo_grant_hotfix.sql'),
  ('014_members_permissions.sql'),
  ('015_invite_only_office_signup.sql'),
  ('016_visit_preferences.sql'),
  ('017_arrival_windows.sql'),
  ('018_addon_amount_tech_grant_revoke.sql')
on conflict do nothing;

-- ============================================================================
-- VERIFICATION (run after the statements above; not part of the change)
-- ============================================================================
select id from public.schema_migrations order by id;
