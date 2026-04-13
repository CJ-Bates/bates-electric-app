-- Bates Electric — Initial Schema
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement uses IF NOT EXISTS / CREATE OR REPLACE where possible.

-- ============================================================
-- 1. PROFILES TABLE
-- Extends auth.users with role + full name.
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role text not null check (role in ('tech', 'office')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. ROLE ASSIGNMENT FUNCTION
-- Decides role from email domain. Rejects anything that
-- doesn't match one of the two Bates patterns.
-- ============================================================
create or replace function public.bates_role_for_email(addr text)
returns text
language plpgsql
immutable
as $$
begin
  if addr ilike '%@bates-electric.com' then
    return 'office';
  elsif addr ilike '%.bateselectric@gmail.com' then
    return 'tech';
  else
    return null;
  end if;
end;
$$;

-- ============================================================
-- 3. SIGNUP TRIGGER
-- When a new auth.users row is inserted, create a matching
-- profile. Reject the signup if the email domain isn't allowed.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned_role text;
begin
  assigned_role := public.bates_role_for_email(new.email);

  if assigned_role is null then
    raise exception 'Email % is not a recognized Bates Electric address', new.email;
  end if;

  insert into public.profiles (id, email, role, full_name)
  values (
    new.id,
    new.email,
    assigned_role,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 4. INSPECTIONS TABLE
-- JSONB `data` holds the full form blob. Indexed columns are
-- duplicated out of `data` so the office dashboard can filter
-- fast without scanning JSON.
-- ============================================================
create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid not null references public.profiles(id) on delete restrict,
  job_date date,
  job_number text,
  customer_name text,
  customer_email text,
  status text not null default 'submitted' check (status in ('draft', 'submitted')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inspections_technician_idx on public.inspections(technician_id);
create index if not exists inspections_job_date_idx on public.inspections(job_date desc);
create index if not exists inspections_customer_idx on public.inspections(customer_name);
create index if not exists inspections_created_idx on public.inspections(created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists inspections_touch_updated on public.inspections;
create trigger inspections_touch_updated
  before update on public.inspections
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 5. PHOTOS TABLE
-- Each row points at an object in the inspection-photos bucket.
-- ============================================================
create table if not exists public.inspection_photos (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  storage_path text not null,
  caption text,
  created_at timestamptz not null default now()
);

create index if not exists inspection_photos_inspection_idx
  on public.inspection_photos(inspection_id);

-- ============================================================
-- 6. ROW LEVEL SECURITY
-- Techs see only their own inspections. Office sees everything.
-- ============================================================
alter table public.profiles        enable row level security;
alter table public.inspections     enable row level security;
alter table public.inspection_photos enable row level security;

-- Helper: current user's role
create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- --- profiles policies ---
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read"
  on public.profiles for select
  using (id = auth.uid() or public.current_role() = 'office');

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update"
  on public.profiles for update
  using (id = auth.uid());

-- --- inspections policies ---
drop policy if exists "inspections read" on public.inspections;
create policy "inspections read"
  on public.inspections for select
  using (technician_id = auth.uid() or public.current_role() = 'office');

drop policy if exists "inspections insert own" on public.inspections;
create policy "inspections insert own"
  on public.inspections for insert
  with check (technician_id = auth.uid());

drop policy if exists "inspections update own" on public.inspections;
create policy "inspections update own"
  on public.inspections for update
  using (technician_id = auth.uid() or public.current_role() = 'office');

drop policy if exists "inspections delete office" on public.inspections;
create policy "inspections delete office"
  on public.inspections for delete
  using (public.current_role() = 'office');

-- --- photos policies (mirror parent inspection) ---
drop policy if exists "photos read" on public.inspection_photos;
create policy "photos read"
  on public.inspection_photos for select
  using (
    exists (
      select 1 from public.inspections i
      where i.id = inspection_id
        and (i.technician_id = auth.uid() or public.current_role() = 'office')
    )
  );

drop policy if exists "photos insert own" on public.inspection_photos;
create policy "photos insert own"
  on public.inspection_photos for insert
  with check (
    exists (
      select 1 from public.inspections i
      where i.id = inspection_id and i.technician_id = auth.uid()
    )
  );

drop policy if exists "photos delete" on public.inspection_photos;
create policy "photos delete"
  on public.inspection_photos for delete
  using (
    exists (
      select 1 from public.inspections i
      where i.id = inspection_id
        and (i.technician_id = auth.uid() or public.current_role() = 'office')
    )
  );

-- ============================================================
-- 7. STORAGE BUCKET for inspection photos
-- ============================================================
insert into storage.buckets (id, name, public)
values ('inspection-photos', 'inspection-photos', false)
on conflict (id) do nothing;

-- Storage policies: authenticated users can upload into their own
-- inspection's folder; reads follow the same rule as inspections.
drop policy if exists "photos storage read" on storage.objects;
create policy "photos storage read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'inspection-photos'
    and exists (
      select 1 from public.inspections i
      where i.id::text = split_part(name, '/', 1)
        and (i.technician_id = auth.uid() or public.current_role() = 'office')
    )
  );

drop policy if exists "photos storage insert" on storage.objects;
create policy "photos storage insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'inspection-photos'
    and exists (
      select 1 from public.inspections i
      where i.id::text = split_part(name, '/', 1)
        and i.technician_id = auth.uid()
    )
  );

drop policy if exists "photos storage delete" on storage.objects;
create policy "photos storage delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'inspection-photos'
    and exists (
      select 1 from public.inspections i
      where i.id::text = split_part(name, '/', 1)
        and (i.technician_id = auth.uid() or public.current_role() = 'office')
    )
  );
