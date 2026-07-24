-- 030_tech_invite_only_signup.sql
-- Close public self-signup for the TECH domain (*.bateselectric@gmail.com).
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
-- Requires 015 (this rewrites the two functions 015 defined).
--
-- WHY: bates_role_for_email() grants role='tech' to any *.bateselectric@gmail.com
-- address, and 015 left the tech branch of the signup trigger ungated. Gmail
-- ignores dots, so an attacker could register acmebateselectric@gmail.com, sign
-- up as acme.bateselectric@gmail.com, confirm their own mail, and self-grant
-- role='tech' + tech_reschedule (lead enroll, Bates-branded email from
-- no-reply@, the staff contacts directory, and a legit-looking tech account).
--
-- WHAT CHANGES:
--   1. New table public.tech_invites — the tech analogue of office_invites (014).
--      Rows are written ONLY by the backend Techs endpoint with the service role
--      (routes/generator-care/techs.js), so an invite can't be forged with the
--      public anon key. claimed_at is stamped by the signup trigger on creation.
--   2. enforce_signup_domain(): the tech branch now requires a tech_invites row
--      (office + customer branches are byte-identical to 015 — nothing weakened).
--   3. handle_new_user(): same tech invite requirement, stamps tech_invites.claimed_at.
--      bates_role_for_email() is NOT touched.
--
-- EXISTING TECHS ARE UNAFFECTED: both triggers fire only on INSERT into
-- auth.users. Current techs (jstimpson.bateselectric@gmail.com,
-- cjbates.bateselectric@gmail.com, ...) already exist, so login is untouched;
-- only NEW tech creation now requires the invite row (the office Techs endpoint
-- writes it before admin.createUser).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('030_tech_invite_only_signup.sql') on conflict do nothing;
--
-- VERIFY after running (expected values in comments):
--   -- (a) table exists with RLS on, no anon/authenticated grants
--   select count(*) as tech_invites_table
--     from information_schema.tables
--    where table_schema = 'public' and table_name = 'tech_invites';                 -- expect 1
--   select relrowsecurity as rls_enabled
--     from pg_class where oid = 'public.tech_invites'::regclass;                     -- expect t
--   -- (b) both functions now reference tech_invites (the gate is live)
--   select count(*) as fns_reference_tech_invites
--     from pg_proc
--    where proname in ('enforce_signup_domain','handle_new_user')
--      and prosrc like '%tech_invites%';                                            -- expect 2

-- ============================================================================
-- 1. tech_invites — mirror of office_invites (014). Written only by the backend
--    Techs endpoint (service role); a tech signup is allowed only when a row
--    exists here.
-- ============================================================================
create table if not exists public.tech_invites (
  email      text primary key check (email = lower(email)),
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

alter table public.tech_invites enable row level security;
revoke all on public.tech_invites from anon, authenticated;

-- ============================================================================
-- 2. Signup gate, first trigger (BEFORE INSERT on auth.users).
--    Office + customer branches unchanged from 015; only the tech branch is gated.
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

  -- Techs are INVITE-ONLY (030): the domain alone no longer passes either.
  if email_lower like '%.bateselectric@gmail.com' then
    if exists (select 1 from public.tech_invites i where i.email = email_lower) then
      return new;
    end if;
    raise exception 'Technician accounts are created by the office. Ask an administrator to add you from the Members / Techs page.';
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
-- 3. Signup gate, second trigger (AFTER INSERT on auth.users).
--    Office + customer branches unchanged from 015; adds the tech invite check.
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

  -- Tech accounts are INVITE-ONLY (030): require the tech_invites row the office
  -- Techs endpoint wrote, and stamp it claimed.
  if assigned_role = 'tech' then
    if not exists (
      select 1 from public.tech_invites i where i.email = lower(new.email)
    ) then
      raise exception 'Technician accounts are created by the office. Ask an administrator to add you from the Members / Techs page.';
    end if;
    update public.tech_invites
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
