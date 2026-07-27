-- 032_inspections_insert_role_check.sql
-- Restrict who can INSERT an inspection at the DATA layer, matching the new
-- route guard (routes/inspections.js now requires role office|tech).
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- WHY: the 001 policy "inspections insert own" only checked
--   with check (technician_id = auth.uid())
-- so ANY authenticated profile — including a customer-role portal account
-- (011) — could insert an inspection under their own id. Submitting an
-- inspection sends a Bates-branded email to a client-supplied data.job_email,
-- so a customer account could trigger branded mail to an arbitrary address.
-- The route now rejects non-staff; this policy is the defense-in-depth backstop
-- (inspections routes use the caller's JWT via supabaseForUser, so RLS applies).
--
-- WHAT CHANGES: the INSERT policy additionally requires the caller's role to be
-- 'office' or 'tech' (via the existing current_role() helper, 001). Ownership is
-- unchanged. Existing techs/office are unaffected; only customer-role inserts
-- (which never legitimately happened) are now blocked at the DB too.
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('032_inspections_insert_role_check.sql') on conflict do nothing;
--
-- VERIFY after running (expected values in comments):
--   -- the INSERT policy's WITH CHECK now references current_role()
--   select pg_get_expr(polwithcheck, polrelid) as with_check
--     from pg_policy
--    where polrelid = 'public.inspections'::regclass
--      and polcmd = 'a';   -- 'a' = INSERT
--   -- expect an expression containing: current_role() = ANY (ARRAY['office','tech'])

drop policy if exists "inspections insert own" on public.inspections;
create policy "inspections insert own"
  on public.inspections for insert
  with check (
    technician_id = auth.uid()
    and public.current_role() in ('office', 'tech')
  );
