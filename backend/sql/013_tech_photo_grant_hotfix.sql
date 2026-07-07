-- 013_tech_photo_grant_hotfix.sql
-- Repo record of a fix ALREADY APPLIED LIVE in the Supabase SQL Editor on
-- 2026-07-07 — do NOT re-run.
--
-- Background: 011's column-level grants replaced the broad SELECT grant on
-- generator_service_visits with a customer-safe column list that did not
-- include assigned_tech_id. The tech photo-upload storage policies from 010
-- (gen visit photos storage read/insert/delete) check ownership by selecting
-- assigned_tech_id from the visit row as the `authenticated` role, so the
-- missing column grant made those policy checks fail and broke tech photo
-- uploads. This grant restores exactly the one column the policies need.

grant select (assigned_tech_id) on public.generator_service_visits to authenticated;
