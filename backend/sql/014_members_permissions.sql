-- 014_members_permissions.sql
-- Members area, part A: admin flag, per-member permissions, office invites.
-- Run manually in the Supabase SQL Editor (idempotent). Do NOT re-run 013 —
-- that file records a hotfix already applied live on 2026-07-07.
--
-- This migration is purely ADDITIVE: it touches no existing function, trigger,
-- or policy. Part B (015) rewrites the signup-gate functions to make office
-- accounts invite-only and tightens the office write policies — it is written
-- against the LIVE function/policy definitions (dumped by the verification
-- query that accompanies this file), because 012 taught us the live DB can
-- hold definitions the repo never saw.
--
-- Design choices (per the 7/7 members build-out decision):
--   * member_permissions is a TABLE, not a jsonb column on profiles: the flags
--     are typed NOT NULL booleans with per-flag defaults, the row carries
--     updated_by/updated_at audit columns, and RLS policies (015) can gate on
--     individual flags through member_has_permission() below.
--   * Flags are consulted per role: the five office flags only matter for
--     office-role profiles; tech_reschedule only matters for tech-role
--     profiles (it gates a tech booking/moving their OWN appointments and
--     defaults true so current tech behavior is unchanged).
--   * A member with no row gets their ROLE DEFAULTS (office: all office flags
--     true; tech: tech_reschedule true) — the same defaults a row is created
--     with. Office rows are backfilled below and created by the invite flow,
--     so the fallback normally only applies to techs, who get no row until a
--     flag is first toggled off.
--   * member_manage is NOT a flag: managing members is admin-only
--     (profiles.is_admin), and admins pass every permission check.

-- ============================================================================
-- 1. Admin flag
-- ============================================================================
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

update public.profiles
   set is_admin = true
 where lower(email) = 'cjbates@bates-electric.com';

-- ============================================================================
-- 2. Per-member permissions
-- ============================================================================
create table if not exists public.member_permissions (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,
  -- Office flags (consulted only for role='office'):
  accounting      boolean not null default true,  -- Accounting tab + payout data
  refunds         boolean not null default true,  -- refund + cancel controls
  billing_actions boolean not null default true,  -- add-on charges, adhoc charges, tier/plan changes, fleet
  customer_edit   boolean not null default true,  -- contact/generator/notes editing
  tech_manage     boolean not null default true,  -- create/deactivate techs, assign visits
  -- Tech flags (consulted only for role='tech'):
  tech_reschedule boolean not null default true,  -- tech may book/move their own appointments
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles(id)
);

-- Service-role only: the backend reads/writes this table; it is not reachable
-- through the public REST API (no grants, RLS enabled with no policies).
alter table public.member_permissions enable row level security;
revoke all on public.member_permissions from anon, authenticated;

-- Backfill: every existing office member gets an all-true row, so Amy, Brenda,
-- Ally, and Hunter keep working exactly as they do today.
insert into public.member_permissions (profile_id)
select id from public.profiles where role = 'office'
on conflict (profile_id) do nothing;

-- ============================================================================
-- 3. Office invites (the gate itself moves into the signup functions in 015)
-- ============================================================================
-- An @bates-electric.com signup will only be allowed when a row exists here.
-- Rows are written exclusively by the backend invite endpoint (service role),
-- so an invite cannot be forged with the public anon key. claimed_at is
-- stamped by the signup trigger (015) when the account is created.
create table if not exists public.office_invites (
  email      text primary key check (email = lower(email)),
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

alter table public.office_invites enable row level security;
revoke all on public.office_invites from anon, authenticated;

-- ============================================================================
-- 4. Flag lookup helper — for RLS policies (015) and any future SQL checks.
--    Admins pass everything; a missing row falls back to the role defaults
--    described in the header.
-- ============================================================================
create or replace function public.member_has_permission(uid uuid, flag text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select p.is_admin from public.profiles p where p.id = uid), false)
    or coalesce(
      (select case flag
                when 'accounting'      then m.accounting
                when 'refunds'         then m.refunds
                when 'billing_actions' then m.billing_actions
                when 'customer_edit'   then m.customer_edit
                when 'tech_manage'     then m.tech_manage
                when 'tech_reschedule' then m.tech_reschedule
                else false
              end
         from public.member_permissions m
        where m.profile_id = uid),
      -- No row: role defaults.
      case
        when flag in ('accounting','refunds','billing_actions','customer_edit','tech_manage')
          then coalesce((select p.role = 'office' from public.profiles p where p.id = uid), false)
        when flag = 'tech_reschedule'
          then coalesce((select p.role = 'tech' from public.profiles p where p.id = uid), false)
        else false
      end
    );
$$;

-- ============================================================================
-- 5. Close a column-grant hole that is_admin would widen
-- ============================================================================
-- The "profiles self update" RLS policy (001) limits the ROW to your own, but
-- authenticated's default UPDATE grant covers every COLUMN — so any signed-in
-- user could set role / active / is_admin on their own row straight through
-- the public REST API. Only full_name is legitimately self-edited (PATCH /me).
-- SELECT grants are untouched (013 showed column grants can break policies
-- that read the table — nothing reads profiles columns from RLS policies via
-- the authenticated role; policies use the security-definer current_role()).
revoke update on public.profiles from anon, authenticated;
grant update (full_name) on public.profiles to authenticated;
