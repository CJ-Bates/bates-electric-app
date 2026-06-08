-- Bates Electric - Generator Program
-- Migration 004: Add 'past_due' to the generator_subscriptions.status enum
--
-- When a renewal charge fails in Stripe, the subscription's status flips to
-- past_due. The Stripe webhook now syncs this back to our DB so Amy can see
-- stuck renewals in the daily digest. The existing check constraint only
-- allowed ('active', 'incomplete', 'canceled'), which would reject the
-- transition with a 500 + Stripe retry loop.
--
-- Safe to re-run.

do $$
declare
  c_name text;
begin
  select conname into c_name
    from pg_constraint
    where conrelid = 'public.generator_subscriptions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%';

  if c_name is not null then
    execute format('alter table public.generator_subscriptions drop constraint %I', c_name);
  end if;
end$$;

alter table public.generator_subscriptions
  add constraint generator_subscriptions_status_check
  check (status in (
    'active',
    'past_due',
    'incomplete',
    'canceled'
  ));
