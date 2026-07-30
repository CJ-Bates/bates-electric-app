-- 033_email_messages.sql
-- Email send history: the email-side twin of generator_sms_messages (025).
-- Every email the app attempts — receipts, welcome, visit-scheduled,
-- visit-complete, set-password/invite, portal/magic links, admin test sends,
-- office notifications, the daily digest — goes through lib/mailer.js
-- sendViaBrevo, which now writes one row per attempt here (sent or failed).
-- A Brevo delivery-events webhook (routes/email-events.js) later stamps the
-- delivery outcome (delivered / bounced / spam / deferred...) onto the row by
-- provider message id, so the office can answer "did the customer actually
-- GET their appointment email?" — not just "did we hand it to Brevo?".
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('033_email_messages.sql') on conflict do nothing;
--
-- VERIFY after running (expected: messages_table=1, rls_enabled=1,
-- client_grants=0, message_rows=0):
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name = 'generator_email_messages') as messages_table,
--     (select count(*) from pg_class
--        where oid = 'public.generator_email_messages'::regclass
--          and relrowsecurity) as rls_enabled,
--     (select count(*) from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name = 'generator_email_messages'
--          and grantee in ('anon', 'authenticated')) as client_grants,
--     (select count(*) from public.generator_email_messages) as message_rows;
--
-- What this does:
--   1. generator_email_messages: one row per send ATTEMPT, success or failure.
--      No HTML body is stored — subject + recipient + kind identify the email;
--      detail carries the failure reason. NEVER the Brevo API key, any token,
--      or a magic-link URL (lib/mailer.js scrubs the detail before insert).
--      status is the send attempt ('sent' = Brevo accepted it); the
--      delivery_* columns are what actually happened afterwards, per Brevo's
--      webhook — a row can be sent-but-bounced.
--   2. Internal/office-only posture, same as generator_sms_messages: RLS
--      enabled with NO policies and an explicit revoke from anon/authenticated
--      — all access goes through the backend service role (same as 020/021/025).

-- ============================================================================
-- 1. Message log
-- ============================================================================
create table if not exists public.generator_email_messages (
  id uuid primary key default gen_random_uuid(),
  to_email text,                     -- recipient(s); comma-joined when multiple
  subject text,
  kind text,                         -- template tag from the caller's logTag, e.g. 'receipt-email'
  status text not null,              -- 'sent' (Brevo accepted) | 'failed' (refused/unreachable/no recipient)
  provider_id text,                  -- Brevo messageId, when we got one (webhook match key)
  detail text,                       -- failure reason (never the API key, a token, or a magic-link URL)
  delivery_status text,              -- from the Brevo webhook: delivered|soft_bounce|hard_bounce|blocked|spam|invalid_email|deferred|error
  delivery_detail text,              -- webhook reason text (bounce message etc.)
  delivery_at timestamptz,           -- when the delivery event happened
  customer_id uuid references public.generator_customers(id) on delete set null,
  subscription_id uuid references public.generator_subscriptions(id) on delete set null,
  related_visit_id uuid references public.generator_service_visits(id) on delete set null,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.generator_email_messages
    add constraint generator_email_messages_status_check
    check (status in ('sent', 'failed'));
exception when duplicate_object then null; end $$;

-- The delivery webhook looks rows up by Brevo message id.
create index if not exists generator_email_messages_provider_idx
  on public.generator_email_messages (provider_id);
-- The customer-record Email History card reads by customer, newest first.
create index if not exists generator_email_messages_customer_idx
  on public.generator_email_messages (customer_id, created_at desc);
create index if not exists generator_email_messages_visit_idx
  on public.generator_email_messages (related_visit_id);

-- ============================================================================
-- 2. Lock the table down — backend service role only (same as 020/021/025).
-- ============================================================================
alter table public.generator_email_messages enable row level security;
revoke all on public.generator_email_messages from anon, authenticated;
