-- 012_customer_signup_gate.sql
-- Repo record of a fix ALREADY APPLIED LIVE in the Supabase SQL Editor on
-- 2026-07-06 — do not re-run unless re-provisioning (idempotent either way:
-- CREATE OR REPLACE only).
--
-- Background: auth.users had a SECOND signup gate besides handle_new_user
-- (001, customer branch added in 011): an enforce_signup_domain() trigger
-- function created directly in the Supabase dashboard before this repo tracked
-- migrations — it appears in no earlier sql/ file. It rejected any email that
-- didn't match the two Bates staff patterns, so a Generator Care customer's
-- portal signup was rejected BEFORE handle_new_user's customer branch (011)
-- ever ran.
--
-- The fix mirrors 011's customer branch: staff patterns pass unchanged; an
-- email on file for an ACTIVE (non-canceled) Generator Care customer passes;
-- everything else raises the same rejection as before.
--
-- NOTE: this file was reconstructed from the repo's own gate functions
-- (bates_role_for_email in 001, handle_new_user in 011) because the live
-- session record wasn't available when it was committed. To confirm it matches
-- what's live, run in the SQL Editor:
--   select pg_get_functiondef('public.enforce_signup_domain'::regprocedure);
-- and replace this definition if it differs.
--
-- Related config change the same day (no SQL): Supabase Auth SMTP was switched
-- from the dead SendGrid credentials to Brevo, so auth emails (magic links)
-- send again.

create or replace function public.enforce_signup_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Staff patterns pass unchanged (same two patterns as bates_role_for_email).
  if new.email ilike '%@bates-electric.com'
     or new.email ilike '%.bateselectric@gmail.com' then
    return new;
  end if;

  -- Generator Care customers: an email the office has on file with at least
  -- one non-canceled subscription (same match as handle_new_user's customer
  -- branch in 011).
  if exists (
    select 1
    from public.generator_customers c
    join public.generator_subscriptions s on s.customer_id = c.id
    where lower(c.email) = lower(new.email)
      and s.status <> 'canceled'
  ) then
    return new;
  end if;

  raise exception 'Email % is not a recognized Bates Electric address', new.email;
end;
$$;
