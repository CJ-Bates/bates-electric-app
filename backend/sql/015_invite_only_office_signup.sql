-- 015_invite_only_office_signup.sql
-- Members area, part B: invite-only office signup + flag-checked office write
-- policies. Run manually in the Supabase SQL Editor (idempotent). Requires 014.
--
-- Written against the LIVE definitions dumped + verified on 2026-07-07 (the
-- verification query in 014's rollout), NOT the repo's reconstructed copies —
-- the live enforce_signup_domain differed from sql/012 (email_lower + like,
-- different rejection message; 012 has been corrected to match). The tech and
-- customer branches below are byte-identical to what was live; only the office
-- path changes.
--
-- What changes:
--   1. enforce_signup_domain(): an @bates-electric.com signup now requires a
--      pre-authorized public.office_invites row (written only by the backend
--      invite endpoint with the service role — see routes/members.js). Techs
--      and Generator Care customers are untouched. Existing office users are
--      untouched (this trigger only fires on INSERT into auth.users).
--   2. handle_new_user(): same invite requirement for the office role, stamps
--      office_invites.claimed_at, and creates the member's default
--      member_permissions row (all flags true — the office role default).
--      bates_role_for_email() is NOT touched.
--   3. The four office WRITE policies on the generator tables additionally
--      require the matching permission flag via member_has_permission(014):
--      customer/subscription writes -> customer_edit; pending-addon/adhoc-
--      charge writes -> billing_actions. Backfill made every current office
--      member all-true, so behavior today is unchanged; this is data-layer
--      backup for the backend middleware (office API traffic runs on the
--      service role, which bypasses RLS — PostgREST with the anon key is the
--      surface this closes). Read policies and tech/customer policies are
--      untouched.

-- ============================================================================
-- 1. Signup gate, first trigger (BEFORE INSERT on auth.users)
-- ============================================================================
create or replace function public.enforce_signup_domain()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  email_lower text := lower(new.email);
begin
  -- Office accounts are INVITE-ONLY (015): the domain alone no longer passes.
  if email_lower like '%@bates-electric.com' then
    if exists (select 1 from public.office_invites i where i.email = email_lower) then
      return new;
    end if;
    raise exception 'Office accounts are created by invitation. Ask an administrator to invite you from the Members page.';
  end if;

  -- Techs: unchanged.
  if email_lower like '%.bateselectric@gmail.com' then
    return new;
  end if;

  -- Customer portal (011): active Generator Care customers may sign in.
  if exists (
    select 1
    from public.generator_customers c
    join public.generator_subscriptions s on s.customer_id = c.id
    where lower(c.email) = email_lower
      and s.status <> 'canceled'
  ) then
    return new;
  end if;

  raise exception 'Sign-ups are restricted to @bates-electric.com or *.bateselectric@gmail.com email addresses. Contact your administrator for access.';
end;
$function$;

-- ============================================================================
-- 2. Signup gate, second trigger (AFTER INSERT on auth.users)
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  assigned_role text;
begin
  assigned_role := public.bates_role_for_email(new.email);

  -- Office accounts are INVITE-ONLY (015): require the invite row the backend
  -- invite endpoint wrote, and stamp it claimed.
  if assigned_role = 'office' then
    if not exists (
      select 1 from public.office_invites i where i.email = lower(new.email)
    ) then
      raise exception 'Office accounts are created by invitation. Ask an administrator to invite you from the Members page.';
    end if;
    update public.office_invites
       set claimed_at = now()
     where email = lower(new.email);
  end if;

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

  -- New office members get their default permissions row (all flags true —
  -- the office role default from 014; admin is granted separately).
  if assigned_role = 'office' then
    insert into public.member_permissions (profile_id)
    values (new.id)
    on conflict (profile_id) do nothing;
  end if;

  return new;
end;
$function$;

-- (Both triggers already point at these functions; no re-create needed.)

-- ============================================================================
-- 3. Office WRITE policies gain the matching permission flag.
--    Same DROP + CREATE pattern as 002; USING/CHECK only ADD a condition —
--    nothing is weakened. Office READ policies are untouched.
-- ============================================================================

-- Customer + subscription edits -> customer_edit
drop policy if exists "gen_customers office write" on public.generator_customers;
create policy "gen_customers office write"
  on public.generator_customers
  as permissive for all to public
  using ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'customer_edit'))
  with check ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'customer_edit'));

drop policy if exists "gen_subs office write" on public.generator_subscriptions;
create policy "gen_subs office write"
  on public.generator_subscriptions
  as permissive for all to public
  using ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'customer_edit'))
  with check ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'customer_edit'));

-- Pending add-ons + adhoc charges -> billing_actions
drop policy if exists "gen_addons office write" on public.generator_pending_addons;
create policy "gen_addons office write"
  on public.generator_pending_addons
  as permissive for all to public
  using ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'billing_actions'))
  with check ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'billing_actions'));

drop policy if exists "gen_adhoc office write" on public.generator_adhoc_charges;
create policy "gen_adhoc office write"
  on public.generator_adhoc_charges
  as permissive for all to public
  using ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'billing_actions'))
  with check ("current_role"() = 'office'::text and public.member_has_permission(auth.uid(), 'billing_actions'));
