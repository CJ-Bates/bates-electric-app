-- 010_tech_phase2.sql
-- Tech dashboard phase 2: visit photos, tech reschedule, field flags.
-- Run manually in the Supabase SQL Editor (idempotent — safe to re-run).
--
-- 1. generator_visit_photos table + RLS (mirrors the inspection_photos pattern)
-- 2. generator-visit-photos storage bucket + storage.objects policies
--    (object names are `<visit_id>/...` so policies check access via
--    split_part(name,'/',1), exactly like inspection-photos)
-- 3. generator_pending_addons.performed_by (actor audit for the tech flip)
-- 4. Tech RLS on generator_pending_addons (assigned-visit-scoped, so the
--    "mark performed" ability is enforceable by policy, not just route JS)

-- ============================================================================
-- 1. Visit photos table
-- ============================================================================
create table if not exists public.generator_visit_photos (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.generator_service_visits(id) on delete cascade,
  -- defaults to the uploader so direct-from-phone inserts don't have to
  -- carry their own uid; the insert policy still verifies it.
  uploaded_by uuid references public.profiles(id) on delete set null default auth.uid(),
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists generator_visit_photos_visit_idx
  on public.generator_visit_photos(visit_id);

alter table public.generator_visit_photos enable row level security;

-- Read: the assigned tech of the parent visit, or office.
drop policy if exists "gen_visit_photos read" on public.generator_visit_photos;
create policy "gen_visit_photos read"
  on public.generator_visit_photos for select
  using (
    exists (
      select 1 from public.generator_service_visits v
      where v.id = visit_id
        and (v.assigned_tech_id = auth.uid() or public.current_role() = 'office')
    )
  );

-- Insert: office, or the assigned tech uploading as themselves. Deliberately
-- NOT locked at completion — techs may attach photos before, during, or after
-- marking the visit complete (deletes DO lock at completion, below).
drop policy if exists "gen_visit_photos insert" on public.generator_visit_photos;
create policy "gen_visit_photos insert"
  on public.generator_visit_photos for insert
  with check (
    public.current_role() = 'office'
    or (
      uploaded_by = auth.uid()
      and exists (
        select 1 from public.generator_service_visits v
        where v.id = visit_id
          and v.assigned_tech_id = auth.uid()
      )
    )
  );

-- Delete: office always; a tech may delete only their OWN photos while the
-- visit is still open (delete-own-before-complete).
drop policy if exists "gen_visit_photos delete" on public.generator_visit_photos;
create policy "gen_visit_photos delete"
  on public.generator_visit_photos for delete
  using (
    public.current_role() = 'office'
    or (
      uploaded_by = auth.uid()
      and exists (
        select 1 from public.generator_service_visits v
        where v.id = visit_id
          and v.assigned_tech_id = auth.uid()
          and v.status <> 'completed'
      )
    )
  );

-- ============================================================================
-- 2. Storage bucket + object policies
-- ============================================================================
-- Private bucket, images only, 10 MB cap per object (uploads go direct from
-- the phone with the tech's JWT, so the bucket itself enforces type/size).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generator-visit-photos', 'generator-visit-photos', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

-- Object names are `<visit_id>/<filename>`; access follows the parent visit.
drop policy if exists "gen visit photos storage read" on storage.objects;
create policy "gen visit photos storage read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'generator-visit-photos'
    and exists (
      select 1 from public.generator_service_visits v
      where v.id::text = split_part(name, '/', 1)
        and (v.assigned_tech_id = auth.uid() or public.current_role() = 'office')
    )
  );

drop policy if exists "gen visit photos storage insert" on storage.objects;
create policy "gen visit photos storage insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'generator-visit-photos'
    and (
      public.current_role() = 'office'
      or exists (
        select 1 from public.generator_service_visits v
        where v.id::text = split_part(name, '/', 1)
          and v.assigned_tech_id = auth.uid()
      )
    )
  );

-- Delete: office always; the tech only for objects they uploaded (storage
-- records the uploader in owner) on their own open visit.
drop policy if exists "gen visit photos storage delete" on storage.objects;
create policy "gen visit photos storage delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'generator-visit-photos'
    and (
      public.current_role() = 'office'
      or (
        owner = auth.uid()
        and exists (
          select 1 from public.generator_service_visits v
          where v.id::text = split_part(name, '/', 1)
            and v.assigned_tech_id = auth.uid()
            and v.status <> 'completed'
        )
      )
    )
  );

-- ============================================================================
-- 3. Add-on performed actor (audit)
-- ============================================================================
alter table public.generator_pending_addons
  add column if not exists performed_by text;  -- who flipped pending -> performed (tech/office name)

-- ============================================================================
-- 4. Tech policies on pending add-ons (field flags)
--    Techs may READ the add-ons of a subscription that has a visit assigned to
--    them, and may only toggle status between pending <-> performed on those
--    rows (never charged/canceled — billing stays office-only). Existing
--    office policies are untouched; these are additional permissive policies.
-- ============================================================================
drop policy if exists "gen_pending_addons tech read" on public.generator_pending_addons;
create policy "gen_pending_addons tech read"
  on public.generator_pending_addons for select
  using (
    exists (
      select 1 from public.generator_service_visits v
      where v.subscription_id = generator_pending_addons.subscription_id
        and v.assigned_tech_id = auth.uid()
    )
  );

drop policy if exists "gen_pending_addons tech perform" on public.generator_pending_addons;
create policy "gen_pending_addons tech perform"
  on public.generator_pending_addons for update
  using (
    status in ('pending', 'performed')
    and exists (
      select 1 from public.generator_service_visits v
      where v.subscription_id = generator_pending_addons.subscription_id
        and v.assigned_tech_id = auth.uid()
        and v.status <> 'completed'
    )
  )
  with check (
    status in ('pending', 'performed')
  );
