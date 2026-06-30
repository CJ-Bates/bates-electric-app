-- 010_recurring_addons.sql
-- Run in the Supabase SQL Editor. Idempotent (safe to re-run).
--
-- Recurring add-on lifecycle: a customer's STANDING (every-visit) add-ons auto-
-- return as Pending each new visit cycle; as-needed add-ons do not. Past charged
-- add-ons are preserved as history, separated from the current cycle.
--
-- Two pieces:
--   1. service_visit_id on each add-on  -> which visit CYCLE it belongs to
--      (current cycle = the sub's open visit; prior cycles = history).
--   2. standing_addons on the subscription -> the editable set of recurring
--      add-on types that auto-return each cycle.
-- The recurring/as-needed classification itself stays in CODE
-- (lib/generator-catalog.js: ADDON_CATALOG[type].recurring); no DB flag.

-- ============================================================
-- 1. generator_pending_addons.service_visit_id (visit-cycle association)
-- ============================================================
ALTER TABLE public.generator_pending_addons
  ADD COLUMN IF NOT EXISTS service_visit_id uuid;

DO $$ BEGIN
  ALTER TABLE public.generator_pending_addons
    ADD CONSTRAINT generator_pending_addons_service_visit_id_fkey
    FOREIGN KEY (service_visit_id) REFERENCES public.generator_service_visits(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS generator_addons_visit_idx
  ON public.generator_pending_addons USING btree (service_visit_id);

-- ============================================================
-- 2. generator_subscriptions.standing_addons (per-customer recurring set)
--    text[] of addon_type values that auto-return each visit. Editable.
-- ============================================================
ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS standing_addons text[];

-- ============================================================
-- 3. Backfill the cycle association: link ACTIVE (not-yet-charged) add-ons to the
--    subscription's current OPEN visit so they show under the current cycle.
--    Charged/canceled add-ons stay NULL -> history. Open visit = the earliest
--    not-completed, not-canceled visit.
-- ============================================================
UPDATE public.generator_pending_addons a
SET service_visit_id = (
  SELECT v.id FROM public.generator_service_visits v
  WHERE v.subscription_id = a.subscription_id
    AND v.completed_date IS NULL
    AND v.status <> 'canceled'
  ORDER BY v.scheduled_date ASC NULLS LAST
  LIMIT 1
)
WHERE a.status IN ('pending', 'performed', 'failed')
  AND a.service_visit_id IS NULL;

-- ============================================================
-- 4. Backfill the standing set: default to the RECURRING-type add-ons each
--    customer already has on file (any status). The recurring types are defined in
--    code (lib/generator-catalog.js); the literal list here is only for this
--    one-time backfill. NULL stays "not yet initialized"; we set [] when none.
-- ============================================================
UPDATE public.generator_subscriptions s
SET standing_addons = COALESCE((
  SELECT array_agg(DISTINCT a.addon_type)
  FROM public.generator_pending_addons a
  WHERE a.subscription_id = s.id
    AND a.addon_type IN ('exterior_wash', 'ats_outage_combined', 'coolant_topoff')
), ARRAY[]::text[])
WHERE s.standing_addons IS NULL;
