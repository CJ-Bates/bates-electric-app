-- 034_sms_operator_reply.sql
-- Two-way SMS: office replies from the customer record. ONE additive,
-- nullable audit column on generator_sms_messages (025): which office user
-- composed and sent an operator reply. Automated sends (confirmations,
-- reminders, nudges, webhook auto-replies) leave it null — lib/sms.js only
-- writes the column when a sender is supplied, so nothing else about the
-- message log changes. Nothing else new is stored about a message.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
-- Run it BEFORE deploying the sms-two-way-thread change: the office
-- sms-messages endpoint joins profiles through this column.
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('034_sms_operator_reply.sql') on conflict do nothing;
--
-- VERIFY after running (expected: audit_column=1, fk=1):
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'generator_sms_messages'
--          and column_name = 'sent_by_profile_id') as audit_column,
--     (select count(*) from pg_constraint
--        where conname = 'generator_sms_messages_sent_by_profile_id_fkey') as fk;

alter table public.generator_sms_messages
  add column if not exists sent_by_profile_id uuid;

-- Named explicitly so the office endpoint's PostgREST embed
-- (profiles!generator_sms_messages_sent_by_profile_id_fkey) is stable.
-- on delete set null: removing a member must never delete or block the
-- message record — the text was still sent.
do $$ begin
  alter table public.generator_sms_messages
    add constraint generator_sms_messages_sent_by_profile_id_fkey
    foreign key (sent_by_profile_id) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;
