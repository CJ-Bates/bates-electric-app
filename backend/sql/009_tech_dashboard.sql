-- 009_tech_dashboard.sql
-- Run in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Idempotent (safe to re-run).
--
-- Field-Tech Dashboard v1 for Generator Care: the office dispatches a tech to a
-- service visit; the tech sees and completes ONLY visits assigned to them.
--
-- Reuses the existing role model from 001_initial_schema.sql:
--   - profiles.role already allows ('tech','office'); role is assigned by email
--     domain (a *.bateselectric@gmail.com address -> 'tech').
--   - public."current_role"() returns the caller's profiles.role.
-- Reuses the existing note columns on generator_service_visits:
--   - notes        = CUSTOMER-VISIBLE completion note (feeds the visit-complete
--                    email + the future customer dashboard). Unchanged.
--   - completed_by = who completed the visit (added in 008). Unchanged.

-- ============================================================
-- 1. profiles.active — deactivate a tech without deleting the account.
--    The API treats active=false as "no access" (checked in requireAuth).
-- ============================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- ============================================================
-- 2. generator_service_visits — dispatch (assignment) + internal note.
--    assigned_tech_id is the DISPATCH target (set by the office BEFORE the
--    visit); it is distinct from technician_id (who actually completed it,
--    set at completion). internal_note is office+tech only — NEVER the customer.
-- ============================================================
ALTER TABLE public.generator_service_visits
  ADD COLUMN IF NOT EXISTS assigned_tech_id uuid,    -- dispatched tech (profiles.id)
  ADD COLUMN IF NOT EXISTS assigned_at      timestamptz, -- when assigned (audit)
  ADD COLUMN IF NOT EXISTS assigned_by      text,     -- who assigned (office user name)
  ADD COLUMN IF NOT EXISTS internal_note    text;     -- office + tech only, never the customer

-- Clear the assignment if the tech profile is ever removed (don't orphan a visit).
DO $$ BEGIN
  ALTER TABLE public.generator_service_visits
    ADD CONSTRAINT generator_service_visits_assigned_tech_id_fkey
    FOREIGN KEY (assigned_tech_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The tech's "my visits" query pulls by assigned_tech_id.
CREATE INDEX IF NOT EXISTS generator_visits_assigned_tech_idx
  ON public.generator_service_visits USING btree (assigned_tech_id);

-- ============================================================
-- 3. RLS — the security boundary.
--    A tech may SELECT/UPDATE ONLY visits ASSIGNED to them (assigned_tech_id =
--    auth.uid()); office keeps full access. INSERT/DELETE stay office-only
--    (techs never create or delete visits). The previous policies scoped on
--    technician_id (only set at completion) — assigned_tech_id is what makes an
--    upcoming visit visible to its dispatched tech. The WITH CHECK on UPDATE
--    stops a tech from reassigning a visit away from themselves.
--    Techs get NO direct access to generator_customers / _subscriptions /
--    _pending_addons / _adhoc_charges (those stay office-only from 002); the
--    tech API returns only curated, non-billing fields via the service role.
-- ============================================================
DROP POLICY IF EXISTS "gen_visits read" ON public.generator_service_visits;
CREATE POLICY "gen_visits read"
  ON public.generator_service_visits
  AS PERMISSIVE FOR SELECT TO public
  USING ((assigned_tech_id = auth.uid()) OR ("current_role"() = 'office'::text));

DROP POLICY IF EXISTS "gen_visits update assigned" ON public.generator_service_visits;
CREATE POLICY "gen_visits update assigned"
  ON public.generator_service_visits
  AS PERMISSIVE FOR UPDATE TO public
  USING ((assigned_tech_id = auth.uid()) OR ("current_role"() = 'office'::text))
  WITH CHECK ((assigned_tech_id = auth.uid()) OR ("current_role"() = 'office'::text));

-- INSERT/DELETE policies from 002 (office-only) are unchanged and remain in force.
