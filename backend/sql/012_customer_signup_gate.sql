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
-- NOTE: this file was originally reconstructed from the repo's own gate
-- functions because the live session record wasn't available. On 2026-07-07
-- the live definition was dumped (pg_get_functiondef, during the 014 rollout)
-- and DIFFERED from the reconstruction (single lower() into email_lower +
-- `like`, and a different rejection message); the body below is the verified
-- live text. Superseded by 015, which makes the office branch invite-only.
--
-- Related config change the same day (no SQL): Supabase Auth SMTP was switched
-- from the dead SendGrid credentials to Brevo, so auth emails (magic links)
-- send again.

create or replace function public.enforce_signup_domain()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  email_lower text := lower(new.email);
begin
  if email_lower like '%@bates-electric.com'
     or email_lower like '%.bateselectric@gmail.com' then
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
