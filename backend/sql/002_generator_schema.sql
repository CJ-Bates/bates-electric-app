-- Bates Electric - Generator Care program
-- Migration 002: Generator Care schema (tables, constraints, indexes, RLS)
--
-- Reflected from Supabase project veiunqctijuzirvpsqkg on 2026-06-08. This
-- file is the source of truth for the generator_* tables going forward; any
-- new column / constraint / index changes should land here too (or in a new
-- migration file).
--
-- Safe to re-run. Uses IF NOT EXISTS for tables and indexes; constraints and
-- policies use exception-swallowing / DROP IF EXISTS patterns because PG 15
-- (Supabase's version) doesn't support IF NOT EXISTS on ADD CONSTRAINT or
-- CREATE POLICY.
--
-- Dependency note: this migration assumes the `profiles` table from
-- 001_initial_schema.sql already exists (referenced by technician_id FKs).
-- Run 001 first on a fresh database.

-- ============================================================
-- 1. TABLES (in FK dependency order)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.generator_customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  phone text,
  install_address text,
  install_city text,
  install_state text,
  install_zip text,
  stripe_customer_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.generator_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  stripe_subscription_id text,
  stripe_customer_id text,
  plan text NOT NULL,
  gen_class text NOT NULL,
  gen_type_label text,
  gen_model text,
  gen_serial text,
  fleet_monitoring boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'::text,
  annual_price_cents integer,
  signup_date date,
  next_visit_due date,
  last_visit_date date,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.generator_service_visits (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  visit_type text NOT NULL,
  scheduled_date date,
  completed_date date,
  status text NOT NULL DEFAULT 'scheduled'::text,
  technician_id uuid,
  addons_performed text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.generator_pending_addons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  addon_type text NOT NULL,
  stripe_price_id text,
  stripe_invoice_item_id text,
  amount_cents integer,
  status text NOT NULL DEFAULT 'pending'::text,
  date_performed date,
  date_charged date,
  stripe_payment_intent_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.generator_adhoc_charges (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  service_visit_id uuid,
  description text NOT NULL,
  amount_cents integer NOT NULL,
  billing_method text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  date_performed date,
  date_charged date,
  stripe_payment_intent_id text,
  stripe_invoice_item_id text,
  notes text,
  technician_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. CONSTRAINTS
-- Wrapped in DO blocks so re-running on an existing DB doesn't error
-- on "constraint already exists".
-- ============================================================

-- Primary keys
do $$ begin alter table public.generator_customers
  add constraint generator_customers_pkey primary key (id);
exception when duplicate_object then null; when invalid_table_definition then null; end $$;

do $$ begin alter table public.generator_subscriptions
  add constraint generator_subscriptions_pkey primary key (id);
exception when duplicate_object then null; when invalid_table_definition then null; end $$;

do $$ begin alter table public.generator_service_visits
  add constraint generator_service_visits_pkey primary key (id);
exception when duplicate_object then null; when invalid_table_definition then null; end $$;

do $$ begin alter table public.generator_pending_addons
  add constraint generator_pending_addons_pkey primary key (id);
exception when duplicate_object then null; when invalid_table_definition then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_pkey primary key (id);
exception when duplicate_object then null; when invalid_table_definition then null; end $$;

-- Unique constraints
do $$ begin alter table public.generator_customers
  add constraint generator_customers_stripe_customer_id_key unique (stripe_customer_id);
exception when duplicate_object then null; when duplicate_table then null; end $$;

do $$ begin alter table public.generator_subscriptions
  add constraint generator_subscriptions_stripe_subscription_id_key unique (stripe_subscription_id);
exception when duplicate_object then null; when duplicate_table then null; end $$;

-- Foreign keys
do $$ begin alter table public.generator_subscriptions
  add constraint generator_subscriptions_customer_id_fkey
  foreign key (customer_id) references public.generator_customers(id) on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_service_visits
  add constraint generator_service_visits_subscription_id_fkey
  foreign key (subscription_id) references public.generator_subscriptions(id) on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_service_visits
  add constraint generator_service_visits_technician_id_fkey
  foreign key (technician_id) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_pending_addons
  add constraint generator_pending_addons_subscription_id_fkey
  foreign key (subscription_id) references public.generator_subscriptions(id) on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_subscription_id_fkey
  foreign key (subscription_id) references public.generator_subscriptions(id) on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_service_visit_id_fkey
  foreign key (service_visit_id) references public.generator_service_visits(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_technician_id_fkey
  foreign key (technician_id) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Check constraints
-- Note: addon_type and status enums for generator_subscriptions and
-- generator_pending_addons are also touched by migrations 003 and 004 (which
-- DROP + recreate the constraint to add new enum values). The values listed
-- here are the up-to-date set as of 2026-06-08; 003/004 are idempotent
-- no-ops when run after this file.

do $$ begin alter table public.generator_subscriptions
  add constraint generator_subscriptions_plan_check
  check (plan = any (array['semi_annual'::text, 'annual'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_subscriptions
  add constraint generator_subscriptions_gen_class_check
  check (gen_class = any (array['air_cooled'::text, 'liquid_22_38'::text, 'liquid_48_150'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_subscriptions
  add constraint generator_subscriptions_status_check
  check (status = any (array['active'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_service_visits
  add constraint generator_service_visits_visit_type_check
  check (visit_type = any (array['regular_service'::text, 'on_demand'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_service_visits
  add constraint generator_service_visits_status_check
  check (status = any (array['tentative'::text, 'scheduled'::text, 'completed'::text, 'canceled'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_pending_addons
  add constraint generator_pending_addons_addon_type_check
  check (addon_type = any (array[
    'battery_diagnostics'::text,
    'battery_replacement'::text,
    'exterior_wash'::text,
    'outage_test'::text,
    'coolant_flush'::text,
    'coolant_topoff'::text,
    'ats_inspection'::text,
    'ats_outage_combined'::text
  ]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_pending_addons
  add constraint generator_pending_addons_status_check
  check (status = any (array['pending'::text, 'scheduled'::text, 'performed'::text, 'charged'::text, 'failed'::text, 'canceled'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_amount_cents_check
  check (amount_cents > 0);
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_billing_method_check
  check (billing_method = any (array['immediate'::text, 'renewal'::text]));
exception when duplicate_object then null; end $$;

do $$ begin alter table public.generator_adhoc_charges
  add constraint generator_adhoc_charges_status_check
  check (status = any (array['pending'::text, 'charged'::text, 'failed'::text, 'canceled'::text]));
exception when duplicate_object then null; end $$;

-- ============================================================
-- 3. INDEXES
-- ============================================================

-- generator_customers
CREATE INDEX IF NOT EXISTS generator_customers_email_idx
  ON public.generator_customers USING btree (lower(email));
CREATE INDEX IF NOT EXISTS generator_customers_name_idx
  ON public.generator_customers USING btree (name);
CREATE INDEX IF NOT EXISTS generator_customers_stripe_idx
  ON public.generator_customers USING btree (stripe_customer_id);

-- generator_subscriptions
CREATE INDEX IF NOT EXISTS generator_subs_customer_idx
  ON public.generator_subscriptions USING btree (customer_id);
CREATE INDEX IF NOT EXISTS generator_subs_status_idx
  ON public.generator_subscriptions USING btree (status);
CREATE INDEX IF NOT EXISTS generator_subs_stripe_idx
  ON public.generator_subscriptions USING btree (stripe_subscription_id);
-- Partial: only active subs are interesting for "what's due next" queries.
CREATE INDEX IF NOT EXISTS generator_subs_next_visit_idx
  ON public.generator_subscriptions USING btree (next_visit_due)
  WHERE (status = 'active'::text);

-- generator_service_visits
CREATE INDEX IF NOT EXISTS generator_visits_sub_idx
  ON public.generator_service_visits USING btree (subscription_id);
CREATE INDEX IF NOT EXISTS generator_visits_technician_idx
  ON public.generator_service_visits USING btree (technician_id);
-- Partial: only scheduled visits get queried by date.
CREATE INDEX IF NOT EXISTS generator_visits_scheduled_idx
  ON public.generator_service_visits USING btree (scheduled_date)
  WHERE (status = 'scheduled'::text);

-- generator_pending_addons
CREATE INDEX IF NOT EXISTS generator_addons_sub_idx
  ON public.generator_pending_addons USING btree (subscription_id);
CREATE INDEX IF NOT EXISTS generator_addons_status_idx
  ON public.generator_pending_addons USING btree (status);

-- generator_adhoc_charges
CREATE INDEX IF NOT EXISTS generator_adhoc_sub_idx
  ON public.generator_adhoc_charges USING btree (subscription_id);
CREATE INDEX IF NOT EXISTS generator_adhoc_status_idx
  ON public.generator_adhoc_charges USING btree (status);
CREATE INDEX IF NOT EXISTS generator_adhoc_visit_idx
  ON public.generator_adhoc_charges USING btree (service_visit_id);

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.generator_customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generator_subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generator_service_visits  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generator_pending_addons  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generator_adhoc_charges   ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. POLICIES
-- DROP IF EXISTS + CREATE pattern (PG 15 doesn't support CREATE POLICY IF
-- NOT EXISTS). All policies gate on "current_role"() = 'office' (or
-- auth.uid()-against-technician_id for service visits).
-- ============================================================

-- generator_customers
DROP POLICY IF EXISTS "gen_customers office read" ON public.generator_customers;
CREATE POLICY "gen_customers office read"
  ON public.generator_customers
  AS PERMISSIVE FOR SELECT TO public
  USING ("current_role"() = 'office'::text);

DROP POLICY IF EXISTS "gen_customers office write" ON public.generator_customers;
CREATE POLICY "gen_customers office write"
  ON public.generator_customers
  AS PERMISSIVE FOR ALL TO public
  USING ("current_role"() = 'office'::text)
  WITH CHECK ("current_role"() = 'office'::text);

-- generator_subscriptions
DROP POLICY IF EXISTS "gen_subs office read" ON public.generator_subscriptions;
CREATE POLICY "gen_subs office read"
  ON public.generator_subscriptions
  AS PERMISSIVE FOR SELECT TO public
  USING ("current_role"() = 'office'::text);

DROP POLICY IF EXISTS "gen_subs office write" ON public.generator_subscriptions;
CREATE POLICY "gen_subs office write"
  ON public.generator_subscriptions
  AS PERMISSIVE FOR ALL TO public
  USING ("current_role"() = 'office'::text)
  WITH CHECK ("current_role"() = 'office'::text);

-- generator_service_visits
-- Techs can SELECT/UPDATE the visits assigned to them (technician_id =
-- auth.uid()); office can SELECT/UPDATE everything. INSERT and DELETE
-- are office-only.
DROP POLICY IF EXISTS "gen_visits read" ON public.generator_service_visits;
CREATE POLICY "gen_visits read"
  ON public.generator_service_visits
  AS PERMISSIVE FOR SELECT TO public
  USING ((technician_id = auth.uid()) OR ("current_role"() = 'office'::text));

DROP POLICY IF EXISTS "gen_visits update assigned" ON public.generator_service_visits;
CREATE POLICY "gen_visits update assigned"
  ON public.generator_service_visits
  AS PERMISSIVE FOR UPDATE TO public
  USING ((technician_id = auth.uid()) OR ("current_role"() = 'office'::text));

DROP POLICY IF EXISTS "gen_visits insert office" ON public.generator_service_visits;
CREATE POLICY "gen_visits insert office"
  ON public.generator_service_visits
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("current_role"() = 'office'::text);

DROP POLICY IF EXISTS "gen_visits delete office" ON public.generator_service_visits;
CREATE POLICY "gen_visits delete office"
  ON public.generator_service_visits
  AS PERMISSIVE FOR DELETE TO public
  USING ("current_role"() = 'office'::text);

-- generator_pending_addons
DROP POLICY IF EXISTS "gen_addons office read" ON public.generator_pending_addons;
CREATE POLICY "gen_addons office read"
  ON public.generator_pending_addons
  AS PERMISSIVE FOR SELECT TO public
  USING ("current_role"() = 'office'::text);

DROP POLICY IF EXISTS "gen_addons office write" ON public.generator_pending_addons;
CREATE POLICY "gen_addons office write"
  ON public.generator_pending_addons
  AS PERMISSIVE FOR ALL TO public
  USING ("current_role"() = 'office'::text)
  WITH CHECK ("current_role"() = 'office'::text);

-- generator_adhoc_charges
DROP POLICY IF EXISTS "gen_adhoc office read" ON public.generator_adhoc_charges;
CREATE POLICY "gen_adhoc office read"
  ON public.generator_adhoc_charges
  AS PERMISSIVE FOR SELECT TO public
  USING ("current_role"() = 'office'::text);

DROP POLICY IF EXISTS "gen_adhoc office write" ON public.generator_adhoc_charges;
CREATE POLICY "gen_adhoc office write"
  ON public.generator_adhoc_charges
  AS PERMISSIVE FOR ALL TO public
  USING ("current_role"() = 'office'::text)
  WITH CHECK ("current_role"() = 'office'::text);
