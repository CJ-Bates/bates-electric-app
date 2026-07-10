-- 023_leads_email_opt_out.sql
-- Growth Engine WP4: opt-out plumbing for the batched enrollment-invite drip.
-- The bulk "Send invites" action (POST /leads/send-invites) emails campaign
-- cohorts ~40 at a time; bulk email legally needs a working unsubscribe, so
-- every lead gets a private unsubscribe token and an opt-out flag the send
-- query excludes on.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('023_leads_email_opt_out.sql') on conflict do nothing;
--
-- VERIFY after running (expected: columns=3, opted_out=0):
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_leads'
--          and column_name in ('email_opt_out', 'opt_out_at', 'unsubscribe_token')) as columns,
--     (select count(*) from public.generator_leads where email_opt_out) as opted_out;
--
-- What this adds to generator_leads (all additive — no existing rows change):
--   email_opt_out      true once the lead clicks the unsubscribe link in an
--                      invite. The bulk send NEVER emails an opted-out lead.
--   opt_out_at         when they opted out (audit; null until they do).
--   unsubscribe_token  random per-lead secret carried in the unsubscribe URL
--                      (?token=..., no lead id in the link). Generated lazily
--                      by the send route on a lead's first invite, so it stays
--                      null for leads never emailed. No index: the table is
--                      ~1,700 rows and unsubscribe clicks are rare.

alter table public.generator_leads
  add column if not exists email_opt_out boolean not null default false;
alter table public.generator_leads
  add column if not exists opt_out_at timestamptz;
alter table public.generator_leads
  add column if not exists unsubscribe_token text;
