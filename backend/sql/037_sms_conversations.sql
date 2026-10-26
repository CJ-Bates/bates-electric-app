-- 037_sms_conversations.sql
-- Office texting inbox: per-customer conversation state, takeover / hand-back
-- audit, per-staff read receipts, and the `texting` member permission.
--
-- What this does:
--   1. generator_sms_conversations: ONE row per (customer, phone). Holds the
--      conversation mode ('auto' = the system answers; 'office' = a staff
--      member owns it and nothing automated goes out), who owns it, the
--      timestamps the idle timeout and the "Needs reply" chip are computed
--      from, and the deferred owner-alert bookkeeping.
--        mode / owner_profile_id / taken_over_at
--        last_office_message_at - last text a staff member sent (idle clock)
--        last_inbound_at         - last text FROM the customer
--        last_outbound_at        - last text actually sent TO the customer
--                                  (any sender)
--        needs_reply_since       - set when the customer sends something a
--                                  human has to answer (free text or a
--                                  reschedule request); cleared when staff
--                                  reply or mark it handled. The daily digest
--                                  lists rows where this is 2+ hours old.
--        owner_alert_due_at / owner_alerted_at - in office mode an inbound
--                                  emails ONLY the owner, and only if they
--                                  have not replied ~10 minutes later.
--      Seeded below from the existing message log so the inbox is populated
--      on day one (all seeded rows start in 'auto' with nothing needing a
--      reply - history is not re-litigated).
--   2. generator_sms_conversation_events: audit log of every mode change
--      (who, when, why). Append-only.
--   3. generator_sms_conversation_reads: per-staff "last read" stamp per
--      conversation; the unread badge is last_inbound_at > last_read_at.
--   4. member_permissions.texting: the Texts tab + sending texts from it.
--      Default true (office role default, same as every other office flag),
--      so nobody loses access on apply.
--   5. Held texts need NO new column: a scheduled text (reminder, booking
--      confirmation, schedule nudge) that comes due while the conversation
--      is in office mode is refused by lib/sms.js with the NEW NON-TERMINAL
--      status 'held' in generator_sms_messages.status (a free-text column,
--      no constraint to change). Because 'held' is non-terminal, the
--      existing queue-and-sweep retry logic (sql/035) re-attempts it after
--      hand-back and the existing staleness rules drop it if it is no longer
--      relevant. The thread shows these rows as "Held".
--   6. Internal/office-only posture for all three tables: RLS enabled with
--      NO policies and an explicit revoke from anon/authenticated - all
--      access goes through the backend service role (same as 020/021/025).
--
-- Purely additive. APPLY BEFORE THE CODE DEPLOYS (the usual
-- apply-before-merge rule): the inbound webhook, lib/sms.js hold gate, the
-- Texts tab endpoints and the permission middleware all read these objects.
-- Run manually in the Supabase SQL Editor (idempotent - safe to re-run; the
-- seed is `on conflict do nothing`).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('037_sms_conversations.sql') on conflict do nothing;
--
-- VERIFY after running (expected: tables=3, texting_column=1, rls_enabled=3,
-- client_grants=0, office_rows=0, needs_reply_rows=0; seeded_conversations =
-- the number of distinct (customer, phone) pairs in generator_sms_messages,
-- at least 1 - the TEST customer Cj has texts):
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public'
--          and table_name in ('generator_sms_conversations', 'generator_sms_conversation_events', 'generator_sms_conversation_reads')) as tables,
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'member_permissions'
--          and column_name = 'texting') as texting_column,
--     (select count(*) from pg_class
--        where oid in ('public.generator_sms_conversations'::regclass,
--                      'public.generator_sms_conversation_events'::regclass,
--                      'public.generator_sms_conversation_reads'::regclass)
--          and relrowsecurity) as rls_enabled,
--     (select count(*) from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name in ('generator_sms_conversations', 'generator_sms_conversation_events', 'generator_sms_conversation_reads')
--          and grantee in ('anon', 'authenticated')) as client_grants,
--     (select count(*) from public.generator_sms_conversations) as seeded_conversations,
--     (select count(*) from public.generator_sms_conversations where mode = 'office') as office_rows,
--     (select count(*) from public.generator_sms_conversations where needs_reply_since is not null) as needs_reply_rows;

-- ============================================================================
-- 1. Conversations
-- ============================================================================
create table if not exists public.generator_sms_conversations (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             uuid not null references public.generator_customers(id) on delete cascade,
  phone                   text not null,                 -- E.164 (+1XXXXXXXXXX); lib/sms.js normalizes
  mode                    text not null default 'auto',  -- 'auto' | 'office'
  owner_profile_id        uuid references public.profiles(id) on delete set null,
  taken_over_at           timestamptz,
  last_office_message_at  timestamptz,
  last_inbound_at         timestamptz,
  last_outbound_at        timestamptz,
  needs_reply_since       timestamptz,
  owner_alert_due_at      timestamptz,
  owner_alerted_at        timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (customer_id, phone)
);

do $$ begin
  alter table public.generator_sms_conversations
    add constraint generator_sms_conversations_mode_check
    check (mode in ('auto', 'office'));
exception when duplicate_object then null; end $$;

-- Inbox list sorts by latest activity; the office-mode gate and the
-- idle-timeout check look only at office rows; the digest and the
-- "Needs reply" filter look only at rows with the stamp set.
create index if not exists generator_sms_conversations_inbound_idx
  on public.generator_sms_conversations (last_inbound_at desc nulls last);
create index if not exists generator_sms_conversations_office_idx
  on public.generator_sms_conversations (mode) where mode = 'office';
create index if not exists generator_sms_conversations_needs_reply_idx
  on public.generator_sms_conversations (needs_reply_since) where needs_reply_since is not null;
create index if not exists generator_sms_conversations_phone_idx
  on public.generator_sms_conversations (phone);

-- ============================================================================
-- 2. Mode-change audit log (append-only)
-- ============================================================================
create table if not exists public.generator_sms_conversation_events (
  id                        uuid primary key default gen_random_uuid(),
  conversation_id           uuid not null references public.generator_sms_conversations(id) on delete cascade,
  from_mode                 text not null,
  to_mode                   text not null,
  reason                    text not null,   -- why the mode changed (see check)
  actor_profile_id          uuid references public.profiles(id) on delete set null,  -- null = the system (idle timeout)
  previous_owner_profile_id uuid references public.profiles(id) on delete set null,
  new_owner_profile_id      uuid references public.profiles(id) on delete set null,
  note                      text,
  created_at                timestamptz not null default now()
);

do $$ begin
  alter table public.generator_sms_conversation_events
    add constraint generator_sms_conversation_events_reason_check
    check (reason in ('manual', 'sent_message', 'idle_timeout'));
exception when duplicate_object then null; end $$;

create index if not exists generator_sms_conversation_events_conv_idx
  on public.generator_sms_conversation_events (conversation_id, created_at desc);

-- ============================================================================
-- 3. Per-staff read receipts
-- ============================================================================
create table if not exists public.generator_sms_conversation_reads (
  conversation_id uuid not null references public.generator_sms_conversations(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, profile_id)
);

-- ============================================================================
-- 4. `texting` member permission (office flag; default true = no one loses
--    access on apply). backend/middleware/permissions.js OFFICE_FLAGS and
--    frontend/members.js OFFICE_FLAGS gain the same key.
-- ============================================================================
alter table public.member_permissions
  add column if not exists texting boolean not null default true;  -- Texts tab + send texts

-- ============================================================================
-- 5. Lock the three tables down - backend service role only.
-- ============================================================================
alter table public.generator_sms_conversations enable row level security;
revoke all on public.generator_sms_conversations from anon, authenticated;
alter table public.generator_sms_conversation_events enable row level security;
revoke all on public.generator_sms_conversation_events from anon, authenticated;
alter table public.generator_sms_conversation_reads enable row level security;
revoke all on public.generator_sms_conversation_reads from anon, authenticated;

-- ============================================================================
-- 6. Seed from the existing message log: one 'auto' conversation per
--    (customer, phone) that has ever exchanged a text, with the activity
--    stamps the inbox sorts by. Unmatched rows (customer_id null = the
--    service team's conversations on the shared number) are NOT seeded.
--    needs_reply_since stays null on purpose - old threads are history, not
--    a to-do list. Re-running adds only pairs that are new since last time.
-- ============================================================================
insert into public.generator_sms_conversations
  (customer_id, phone, last_inbound_at, last_outbound_at, created_at)
select
  m.customer_id,
  case when m.direction = 'in' then m.from_phone else m.to_phone end as phone,
  max(m.created_at) filter (where m.direction = 'in')                         as last_inbound_at,
  max(m.created_at) filter (where m.direction = 'out' and m.status = 'sent')  as last_outbound_at,
  min(m.created_at)                                                           as created_at
from public.generator_sms_messages m
where m.customer_id is not null
  and (case when m.direction = 'in' then m.from_phone else m.to_phone end) ~ '^\+1[0-9]{10}$'
group by 1, 2
on conflict (customer_id, phone) do nothing;
