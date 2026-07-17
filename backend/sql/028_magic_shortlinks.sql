-- 028_magic_shortlinks.sql
-- Branded SMS short links for the auto-login magic link (Phase 3 follow-up).
-- The schedule-nudge text used to carry the raw Supabase action_link — a
-- 200+ character supabase.co URL that reads like phishing in an SMS. Now the
-- text carries https://my.bates-electric.com/s/<token> and this table maps
-- the token to the real action_link; GET /s/:token (routes/magic-shortlink.js)
-- redeems it with a 302.
--
-- Security posture:
--   - token is ~12 chars of crypto-random base64url (72 bits) — unguessable,
--     and the redeem route is rate-limited against enumeration.
--   - target_url IS the credential (the single-use Supabase login link). It
--     never appears in any log or response body — only in the 302 Location
--     header of a successful redeem. Service-role-only access: RLS enabled
--     with NO policies + explicit revoke, same as 020/021/025.
--   - Single-use: the redeem route claims the row by stamping used_at; a
--     second hit redirects to the "link expired" sign-in page. The underlying
--     Supabase link is single-use too — double protection.
--   - Short-lived: expires_at is set at mint time (30 min — at/under the
--     Supabase OTP expiry, so the short link never outlives the real one).
--     Rows are inert once used/expired; the daily cron purges old ones.
--
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('028_magic_shortlinks.sql') on conflict do nothing;
--
-- VERIFY after running (expected: shortlinks_table=1, rls_enabled=1, client_grants=0):
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name = 'generator_magic_shortlinks') as shortlinks_table,
--     (select count(*) from pg_class
--        where oid = 'public.generator_magic_shortlinks'::regclass
--          and relrowsecurity) as rls_enabled,
--     (select count(*) from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name = 'generator_magic_shortlinks'
--          and grantee in ('anon', 'authenticated')) as client_grants;

create table if not exists public.generator_magic_shortlinks (
  token       text primary key,           -- url-safe crypto-random, ~12 chars
  target_url  text not null,              -- the Supabase action_link (SECRET — never log/render)
  customer_id uuid references public.generator_customers(id) on delete set null, -- audit only
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- The daily purge deletes by expiry.
create index if not exists idx_magic_shortlinks_expires
  on public.generator_magic_shortlinks (expires_at);

-- Service-role only: RLS on with no policies + revoke (same as 020/021/025).
alter table public.generator_magic_shortlinks enable row level security;
revoke all on public.generator_magic_shortlinks from anon, authenticated;
