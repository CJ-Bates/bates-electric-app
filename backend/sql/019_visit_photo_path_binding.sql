-- 019_visit_photo_path_binding.sql
-- WP4 / H3 — OPTIONAL follow-up hardening (the generator-tech.js handler checks
-- are the actual fix; this is belt-and-suspenders). Run manually in the Supabase
-- SQL Editor. Safe to defer.
--
-- Background: generator_visit_photos' INSERT policy (sql/010_tech_phase2.sql)
-- checks visit_id + uploaded_by but never binds storage_path's `<visit_id>/`
-- prefix to visit_id. A tech can therefore insert a row on their OWN assigned
-- visit whose storage_path points at ANOTHER visit's object. Every backend
-- reader that signs/removes storage_path with the service role is then a
-- confused deputy — not just routes/generator-tech.js (fixed in the handler),
-- but also routes/customer.js and routes/generator-care/visits.js, which sign
-- the raw storage_path too. This CHECK closes the hole at the data layer for
-- ALL of them, at insert time, without touching those route files.
--
-- Objects are named `<visit_id>/<filename>` (frontend uploader convention), so
-- split_part(storage_path, '/', 1) is the visit uuid as text.

-- Step 0 (RUN FIRST): find any pre-existing rows that would violate the check.
--   Expect ZERO rows on healthy data. If this returns rows, investigate before
--   adding the constraint (do NOT blindly delete — a non-empty result may itself
--   be evidence of the exploit, or of a legacy naming scheme).
select id, visit_id, storage_path
from public.generator_visit_photos
where split_part(storage_path, '/', 1) <> visit_id::text;

-- Step 1: add the constraint NOT VALID. This ENFORCES the rule on every future
--   INSERT/UPDATE immediately (closing the vector) while skipping the scan of
--   existing rows — no full-table lock, safe on LIVE data.
do $$ begin
  alter table public.generator_visit_photos
    add constraint generator_visit_photos_path_prefix_check
    check (split_part(storage_path, '/', 1) = visit_id::text) not valid;
exception when duplicate_object then null; end $$;

-- Step 2 (OPTIONAL, run only after Step 0 returned zero rows): validate the
--   constraint against existing rows so the catalog marks it fully trusted.
--   Skip this if Step 0 found violators you haven't resolved.
-- alter table public.generator_visit_photos
--   validate constraint generator_visit_photos_path_prefix_check;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- Constraint exists (convalidated = false until Step 2 is run):
select conname, convalidated
from pg_constraint
where conrelid = 'public.generator_visit_photos'::regclass
  and conname = 'generator_visit_photos_path_prefix_check';
