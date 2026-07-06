-- 011_customer_portal.sql
-- Customer Dashboard v1: magic-link (Supabase OTP) auth for Generator Care
-- customers. Run manually in the Supabase SQL Editor (idempotent).
--
-- APPLY ORDER: run 010_tech_phase2.sql first if you haven't — section 5 below
-- adds a customer read policy on generator_visit_photos when that table
-- exists (it no-ops gracefully if it doesn't, so this file is safe either way).
--
-- What this does:
--   1. profiles.role gains 'customer'; the signup trigger assigns it to any
--      email matching an ACTIVE (non-canceled) Generator Care customer.
--      Bates domains keep office/tech exactly as-is; anything else is still
--      rejected.
--   2. Customers can SELECT their own rows (matched by email) on
--      generator_customers / generator_subscriptions / generator_service_visits
--      / generator_pending_addons — read-only, no INSERT/UPDATE policies; all
--      writes go through backend endpoints.
--   3. Column-level grants: the row policies alone would let a signed-in
--      customer read internal_note, office notes, and Stripe ids straight
--      through Supabase REST (the anon key is public by design). We therefore
--      restrict which COLUMNS the `authenticated` role can select on those
--      tables to the customer-safe set. Staff dashboards are unaffected — all
--      office/tech reads of these tables go through the backend service role,
--      which bypasses grants and RLS.

-- ============================================================================
-- 1. Role model: 'customer'
-- ============================================================================
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('tech', 'office', 'customer'));

-- Staff matching stays in bates_role_for_email (unchanged). The signup gate
-- learns the customer case: an email on file for a customer with at least one
-- non-canceled subscription gets role 'customer'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned_role text;
begin
  assigned_role := public.bates_role_for_email(new.email);

  -- Not a Bates staff address: allow ACTIVE Generator Care customers in as
  -- role 'customer' (matched by the email the office has on file).
  if assigned_role is null then
    if exists (
      select 1
      from public.generator_customers c
      join public.generator_subscriptions s on s.customer_id = c.id
      where lower(c.email) = lower(new.email)
        and s.status <> 'canceled'
    ) then
      assigned_role := 'customer';
    end if;
  end if;

  if assigned_role is null then
    raise exception 'Email % is not a recognized Bates Electric address', new.email;
  end if;

  insert into public.profiles (id, email, role, full_name)
  values (
    new.id,
    new.email,
    assigned_role,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );

  return new;
end;
$$;

-- (The trigger itself already points at handle_new_user(); no re-create needed.)

-- ============================================================================
-- 2. Customer read policies (email-matched, SELECT only)
-- ============================================================================
drop policy if exists "gen_customers customer self read" on public.generator_customers;
create policy "gen_customers customer self read"
  on public.generator_customers for select
  using (
    public.current_role() = 'customer'
    and lower(email) = lower(auth.jwt() ->> 'email')
  );

drop policy if exists "gen_subs customer read" on public.generator_subscriptions;
create policy "gen_subs customer read"
  on public.generator_subscriptions for select
  using (
    public.current_role() = 'customer'
    and exists (
      select 1 from public.generator_customers c
      where c.id = customer_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

drop policy if exists "gen_visits customer read" on public.generator_service_visits;
create policy "gen_visits customer read"
  on public.generator_service_visits for select
  using (
    public.current_role() = 'customer'
    and exists (
      select 1
      from public.generator_subscriptions s
      join public.generator_customers c on c.id = s.customer_id
      where s.id = subscription_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

drop policy if exists "gen_pending_addons customer read" on public.generator_pending_addons;
create policy "gen_pending_addons customer read"
  on public.generator_pending_addons for select
  using (
    public.current_role() = 'customer'
    and exists (
      select 1
      from public.generator_subscriptions s
      join public.generator_customers c on c.id = s.customer_id
      where s.id = subscription_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- ============================================================================
-- 3. Column-level grants (customer-safe columns only for direct REST reads)
--    internal_note, office notes, raw_metadata, and Stripe ids stay
--    service-role-only. The backend serves curated shapes; these grants make
--    the RLS row policies safe even for direct PostgREST queries.
-- ============================================================================
revoke select on public.generator_customers from authenticated;
grant select (id, name, email, phone, install_address, install_city, install_state, install_zip, created_at)
  on public.generator_customers to authenticated;

revoke select on public.generator_subscriptions from authenticated;
grant select (id, customer_id, plan, gen_class, gen_type_label, gen_model, gen_serial,
              fleet_monitoring, status, annual_price_cents, signup_date, next_visit_due,
              last_visit_date, created_at)
  on public.generator_subscriptions to authenticated;

revoke select on public.generator_service_visits from authenticated;
grant select (id, subscription_id, visit_type, scheduled_date, appointment_at,
              completed_date, status, notes, created_at)
  on public.generator_service_visits to authenticated;

revoke select on public.generator_pending_addons from authenticated;
grant select (id, subscription_id, addon_type, amount_cents, status, date_performed, created_at)
  on public.generator_pending_addons to authenticated;

-- ============================================================================
-- 4. Belt-and-suspenders: customers get NO write path anywhere (no policies
--    added), and the tech/office write policies above already gate by role.
-- ============================================================================

-- ============================================================================
-- 5. Visit photos (tech phase 2) — customer read, when the table exists.
-- ============================================================================
do $$
begin
  if to_regclass('public.generator_visit_photos') is not null then
    execute $pol$
      drop policy if exists "gen_visit_photos customer read" on public.generator_visit_photos;
      create policy "gen_visit_photos customer read"
        on public.generator_visit_photos for select
        using (
          public.current_role() = 'customer'
          and exists (
            select 1
            from public.generator_service_visits v
            join public.generator_subscriptions s on s.id = v.subscription_id
            join public.generator_customers c on c.id = s.customer_id
            where v.id = visit_id
              and lower(c.email) = lower(auth.jwt() ->> 'email')
          )
        );
    $pol$;
  end if;
end $$;
