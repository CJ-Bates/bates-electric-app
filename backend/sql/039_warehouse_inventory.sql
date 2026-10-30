-- 039_warehouse_inventory.sql
-- Warehouse inventory: items, barcodes, serialized units, photos, the
-- append-only transaction ledger, count sessions, three member permissions,
-- and a private photo bucket.
--
-- What this does:
--   1. inventory_items: one row per product/SKU. qty_on_hand is a CACHE of
--      the ledger, written only by public.inventory_post_txn() (a trigger
--      refuses any other change to it), so the number on screen can never
--      drift from the audit trail. qty is numeric(12,2) so wire by the foot
--      works; scans move it by whole units.
--      Surplus is a QUANTITY, not a flag (CJ, 2026-10-30): surplus_qty is the
--      part of qty_on_hand that is for sale ("24 kits: keep 6, surplus 18";
--      keep = qty_on_hand - surplus_qty). Selling or disposing reduces it
--      first, and it can never exceed what is on hand (constraint; the ledger
--      function trims it when stock drops below it).
--   2. inventory_barcodes: an item can carry several barcodes. code_norm is
--      the normalized value the backend computes (UPC-E -> UPC-A -> EAN-13,
--      AIM prefixes and whitespace stripped) and is unique, so one barcode
--      can never point at two items.
--   3. inventory_units: serialized gear (ATSs). One row per physical unit;
--      the item's qty_on_hand = its in_stock units, kept so by the ledger.
--   4. inventory_photos: storage paths in the private inventory-photos
--      bucket (served as short-lived signed URLs by the backend, same as
--      visit photos). unit_id set = a photo of one serialized unit.
--   5. inventory_count_sessions / inventory_count_lines: the rapid initial
--      count. Lines hold ABSOLUTE counted quantities (idempotent upserts -
--      safe to resend from an offline phone); posting a session writes one
--      ledger row per item, once (partial unique index). Sessions ADD; when
--      an item was already counted in another session the phone asks "add
--      to it or replace it?" and the line's mode records the answer
--      ('replace' posts an adjustment that sets the qty to this count).
--   6. inventory_transactions: the append-only ledger (a trigger refuses
--      UPDATE / DELETE). client_op_id is unique: an offline phone that
--      resends a queued scan gets the original row back, never a second one.
--   7. inventory_post_txn() / inventory_post_count_session(): the only
--      writers of quantities. Each call locks the item, writes the ledger
--      row and the new qty in one transaction. Backend (service role) only.
--   8. member_permissions.inventory_view / inventory_scan_out /
--      inventory_manage. NULLABLE on purpose: NULL = the ROLE DEFAULT
--      (office: view; tech: view + scan out; manage: nobody but admins),
--      resolved in backend/middleware/permissions.js. A plain column default
--      can't differ by role. manage implies scan_out implies view.
--   9. Storage bucket inventory-photos (private, 5 MB, images only, no
--      storage policies = no client access at all).
--
-- All constraints and indexes are NAMED explicitly (037's 63-char
-- truncation lesson). Longest name here: 47 chars.
--
-- RLS on + all client grants revoked on every table; functions revoked from
-- PUBLIC / anon / authenticated (Supabase grants new functions to them by
-- default). Everything goes through the Express backend.
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('039_warehouse_inventory.sql') on conflict do nothing;
--
-- VERIFY after running. Expected: tables=7, rls_enabled=7, client_grants=0,
-- perm_columns=3, functions=3, function_client_grants=0, ledger_trigger=1,
-- qty_guard_trigger=1, bucket_private=1, ledger_mismatches=0:
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public' and table_name in
--          ('inventory_items','inventory_barcodes','inventory_units','inventory_photos',
--           'inventory_count_sessions','inventory_count_lines','inventory_transactions')) as tables,
--     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--        where n.nspname = 'public' and c.relname like 'inventory\_%' and c.relkind = 'r'
--          and c.relrowsecurity) as rls_enabled,
--     (select count(*) from information_schema.role_table_grants
--        where table_schema = 'public' and table_name like 'inventory\_%'
--          and grantee in ('anon', 'authenticated')) as client_grants,
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'member_permissions'
--          and column_name in ('inventory_view','inventory_scan_out','inventory_manage')) as perm_columns,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname in
--          ('inventory_post_txn','inventory_post_count_session','inventory_guard')) as functions,
--     (select count(*) from information_schema.routine_privileges
--        where routine_schema = 'public' and routine_name like 'inventory\_%'
--          and grantee in ('PUBLIC','anon','authenticated')) as function_client_grants,
--     (select count(*) from pg_trigger where tgname = 'inventory_transactions_append_only') as ledger_trigger,
--     (select count(*) from pg_trigger where tgname = 'inventory_items_qty_guard') as qty_guard_trigger,
--     (select count(*) from storage.buckets where id = 'inventory-photos' and public = false) as bucket_private,
--     (select count(*) from public.inventory_items i
--        where i.qty_on_hand <> coalesce((select sum(t.qty_change) from public.inventory_transactions t
--                                          where t.item_id = i.id), 0)) as ledger_mismatches;

-- ============================================================================
-- 1. Items
-- ============================================================================
create table if not exists public.inventory_items (
  id                  uuid not null default gen_random_uuid(),  -- client-supplied when created offline
  description         text not null,
  manufacturer        text,
  part_number         text,
  category            text not null default 'misc',  -- validated by the backend list (no DDL to add one)
  unit_of_measure     text not null default 'each',
  unit_cost_cents     integer,
  location            text,                          -- free-text shelf / bin note
  condition           text not null default 'new',
  notes               text,
  serialized          boolean not null default false,
  qty_on_hand         numeric(12,2) not null default 0,  -- ledger cache; only inventory_post_txn() writes it
  surplus_qty         numeric(12,2) not null default 0,  -- the for-sale part of qty_on_hand
  surplus_price_cents integer,                       -- asking price per unit
  surplus_notes       text,
  archived_at         timestamptz,                   -- items are archived, never deleted (the ledger references them)
  last_activity_at    timestamptz,                   -- last ledger row; drives "not touched in 12+ months"
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_by          uuid,
  updated_at          timestamptz not null default now(),
  constraint inventory_items_pkey primary key (id),
  constraint inventory_items_condition_chk check (condition in ('new', 'open_box', 'used')),
  constraint inventory_items_cost_chk check (unit_cost_cents is null or unit_cost_cents >= 0),
  constraint inventory_items_price_chk check (surplus_price_cents is null or surplus_price_cents >= 0),
  constraint inventory_items_surplus_qty_chk check (surplus_qty >= 0 and surplus_qty <= greatest(qty_on_hand, 0)),
  constraint inventory_items_desc_chk check (length(btrim(description)) > 0),
  constraint inventory_items_created_by_fk foreign key (created_by) references public.profiles(id) on delete set null,
  constraint inventory_items_updated_by_fk foreign key (updated_by) references public.profiles(id) on delete set null
);
create index if not exists inventory_items_part_idx on public.inventory_items (lower(part_number));
create index if not exists inventory_items_category_idx on public.inventory_items (category) where archived_at is null;
create index if not exists inventory_items_surplus_idx on public.inventory_items (id) where surplus_qty > 0 and archived_at is null;

-- ============================================================================
-- 2. Barcodes (several per item; one item per barcode)
-- ============================================================================
create table if not exists public.inventory_barcodes (
  id          uuid not null default gen_random_uuid(),
  item_id     uuid not null,
  code        text not null,          -- exactly as scanned / typed
  code_norm   text not null,          -- normalized (backend lib/barcodes.js)
  format      text,                   -- ean_13, upc_a, code_128, qr_code, data_matrix, ... or 'manual'
  created_by  uuid,
  created_at  timestamptz not null default now(),
  constraint inventory_barcodes_pkey primary key (id),
  constraint inventory_barcodes_code_norm_key unique (code_norm),
  constraint inventory_barcodes_item_fk foreign key (item_id) references public.inventory_items(id) on delete cascade,
  constraint inventory_barcodes_created_by_fk foreign key (created_by) references public.profiles(id) on delete set null
);
create index if not exists inventory_barcodes_item_idx on public.inventory_barcodes (item_id);

-- ============================================================================
-- 3. Serialized units
-- ============================================================================
create table if not exists public.inventory_units (
  id             uuid not null default gen_random_uuid(),  -- client-supplied when created offline
  item_id        uuid not null,
  serial_number  text not null,
  condition      text not null default 'new',
  notes          text,
  status         text not null default 'pending',  -- pending until its first ledger row puts it in stock
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint inventory_units_pkey primary key (id),
  constraint inventory_units_item_serial_key unique (item_id, serial_number),
  constraint inventory_units_status_chk check (status in ('pending', 'in_stock', 'out', 'sold', 'disposed')),
  constraint inventory_units_condition_chk check (condition in ('new', 'open_box', 'used')),
  constraint inventory_units_item_fk foreign key (item_id) references public.inventory_items(id) on delete restrict,
  constraint inventory_units_created_by_fk foreign key (created_by) references public.profiles(id) on delete set null
);
create index if not exists inventory_units_serial_idx on public.inventory_units (lower(serial_number));
create index if not exists inventory_units_item_status_idx on public.inventory_units (item_id, status);

-- ============================================================================
-- 4. Photos (private bucket inventory-photos, path '<item_id>/<uuid>.jpg')
-- ============================================================================
create table if not exists public.inventory_photos (
  id            uuid not null default gen_random_uuid(),
  item_id       uuid not null,
  unit_id       uuid,
  storage_path  text not null,
  is_primary    boolean not null default false,
  uploaded_by   uuid,
  created_at    timestamptz not null default now(),
  constraint inventory_photos_pkey primary key (id),
  constraint inventory_photos_path_key unique (storage_path),
  constraint inventory_photos_item_fk foreign key (item_id) references public.inventory_items(id) on delete cascade,
  constraint inventory_photos_unit_fk foreign key (unit_id) references public.inventory_units(id) on delete cascade,
  constraint inventory_photos_uploaded_by_fk foreign key (uploaded_by) references public.profiles(id) on delete set null
);
create index if not exists inventory_photos_item_idx on public.inventory_photos (item_id);

-- ============================================================================
-- 5. Count sessions (the rapid initial scan-in)
-- ============================================================================
create table if not exists public.inventory_count_sessions (
  id           uuid not null,                    -- generated on the phone (works offline)
  started_by   uuid,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'open',
  note         text,
  constraint inventory_count_sessions_pkey primary key (id),
  constraint inventory_count_sessions_status_chk check (status in ('open', 'posted', 'discarded')),
  constraint inventory_count_sessions_started_by_fk foreign key (started_by) references public.profiles(id) on delete set null
);

create table if not exists public.inventory_count_lines (
  session_id   uuid not null,
  item_id      uuid not null,
  counted_qty  numeric(12,2) not null,           -- ABSOLUTE count this session (resend-safe)
  mode         text not null default 'add',      -- 'replace' = set the item's qty to this count
  updated_at   timestamptz not null default now(),
  constraint inventory_count_lines_pkey primary key (session_id, item_id),
  constraint inventory_count_lines_qty_chk check (counted_qty >= 0),
  constraint inventory_count_lines_mode_chk check (mode in ('add', 'replace')),
  constraint inventory_count_lines_session_fk foreign key (session_id) references public.inventory_count_sessions(id) on delete cascade,
  constraint inventory_count_lines_item_fk foreign key (item_id) references public.inventory_items(id) on delete cascade
);

-- ============================================================================
-- 6. Ledger (append-only)
-- ============================================================================
create table if not exists public.inventory_transactions (
  id             uuid not null default gen_random_uuid(),
  item_id        uuid not null,
  unit_id        uuid,
  txn_type       text not null,
  qty_change     numeric(12,2) not null,
  resulting_qty  numeric(12,2) not null,
  actor_id       uuid,
  created_at     timestamptz not null default now(),   -- when the server recorded it
  occurred_at    timestamptz not null default now(),   -- when it happened on the phone (offline queue)
  job_note       text,                                 -- "for what?" free text
  customer_id    uuid,                                 -- "for what?" Generator Care customer
  note           text,
  client_op_id   uuid,                                 -- idempotency key from the phone
  session_id     uuid,
  source         text,                                 -- camera / scanner / manual / offline
  constraint inventory_transactions_pkey primary key (id),
  constraint inventory_transactions_client_op_key unique (client_op_id),
  constraint inventory_transactions_type_chk check (txn_type in
    ('initial_count', 'received', 'scanned_out', 'adjustment', 'sold', 'disposed')),
  constraint inventory_transactions_item_fk foreign key (item_id) references public.inventory_items(id) on delete restrict,
  constraint inventory_transactions_unit_fk foreign key (unit_id) references public.inventory_units(id) on delete restrict,
  constraint inventory_transactions_actor_fk foreign key (actor_id) references public.profiles(id) on delete set null,
  constraint inventory_transactions_customer_fk foreign key (customer_id) references public.generator_customers(id) on delete set null,
  constraint inventory_transactions_session_fk foreign key (session_id) references public.inventory_count_sessions(id) on delete restrict
);
create index if not exists inventory_txn_item_idx on public.inventory_transactions (item_id, created_at desc);
create index if not exists inventory_txn_type_idx on public.inventory_transactions (txn_type, created_at desc);
-- A count session posts each (non-serialized) item at most once.
create unique index if not exists inventory_txn_session_item_key
  on public.inventory_transactions (session_id, item_id)
  where session_id is not null and unit_id is null;

-- ============================================================================
-- 7. Guards + the only quantity writers
-- ============================================================================
-- Ledger rows are never edited or removed; mistakes are fixed with a new
-- 'adjustment' row.
create or replace function public.inventory_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'inventory_transactions' then
    raise exception 'inventory_transactions is append-only (post an adjustment instead)';
  end if;
  -- inventory_items: qty_on_hand may only change inside inventory_post_txn().
  if new.qty_on_hand is distinct from old.qty_on_hand
     and coalesce(current_setting('inventory.posting', true), '') <> 'on' then
    raise exception 'inventory_items.qty_on_hand is maintained by the ledger (use inventory_post_txn)';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_transactions_append_only on public.inventory_transactions;
create trigger inventory_transactions_append_only
  before update or delete on public.inventory_transactions
  for each row execute function public.inventory_guard();

drop trigger if exists inventory_items_qty_guard on public.inventory_items;
create trigger inventory_items_qty_guard
  before update on public.inventory_items
  for each row execute function public.inventory_guard();

-- Post one ledger row and move the quantity, atomically, under a row lock.
--   Non-serialized: pass p_qty_change (signed), or p_set_qty with
--     txn_type 'adjustment' ("Count": the change is computed under the lock).
--     received / initial_count must be > 0; scanned_out / sold / disposed
--     < 0; adjustment may be 0 (a recount that confirmed the number).
--     A scan-out may take qty below zero ONLY when it comes from the offline
--     queue (p_allow_negative) - the part physically left; the item then
--     shows in "Needs recount". The backend refuses it for live requests.
--   Serialized: pass p_unit_id; the type moves the unit
--     (initial_count / received -> in_stock, scanned_out -> out,
--     sold -> sold, disposed -> disposed) and the qty by exactly 1.
-- Idempotent on p_client_op_id: a resend returns the original row.
create or replace function public.inventory_post_txn(
  p_item_id        uuid,
  p_type           text,
  p_actor_id       uuid,
  p_qty_change     numeric default null,
  p_set_qty        numeric default null,
  p_unit_id        uuid default null,
  p_client_op_id   uuid default null,
  p_session_id     uuid default null,
  p_job_note       text default null,
  p_customer_id    uuid default null,
  p_note           text default null,
  p_occurred_at    timestamptz default null,
  p_source         text default null,
  p_allow_negative boolean default false
)
returns public.inventory_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.inventory_transactions;
  v_item     public.inventory_items;
  v_unit     public.inventory_units;
  v_change   numeric(12,2);
  v_result   numeric(12,2);
  v_status   text;
  v_surplus  numeric(12,2);
  v_row      public.inventory_transactions;
begin
  if p_client_op_id is not null then
    select * into v_existing from inventory_transactions where client_op_id = p_client_op_id;
    if found then return v_existing; end if;
  end if;

  select * into v_item from inventory_items where id = p_item_id for update;
  if not found then
    raise exception 'inventory item % not found', p_item_id using errcode = 'P0002';
  end if;

  if v_item.serialized then
    if p_unit_id is null then
      raise exception 'serialized item: pick the unit (serial number)' using errcode = '22023';
    end if;
    select * into v_unit from inventory_units where id = p_unit_id and item_id = p_item_id for update;
    if not found then
      raise exception 'unit % not found on this item', p_unit_id using errcode = 'P0002';
    end if;
    if p_type in ('initial_count', 'received') then
      if v_unit.status = 'in_stock' then
        raise exception 'unit % is already in stock', v_unit.serial_number using errcode = '22023';
      end if;
      v_status := 'in_stock'; v_change := 1;
    elsif p_type in ('scanned_out', 'sold', 'disposed') then
      if v_unit.status <> 'in_stock' then
        raise exception 'unit % is not in stock', v_unit.serial_number using errcode = '22023';
      end if;
      v_status := case p_type when 'scanned_out' then 'out' when 'sold' then 'sold' else 'disposed' end;
      v_change := -1;
    else
      raise exception 'serialized items move by unit: receive or scan out the unit' using errcode = '22023';
    end if;
    update inventory_units set status = v_status, updated_at = now() where id = p_unit_id;
  else
    if p_unit_id is not null then
      raise exception 'this item is not serial-tracked' using errcode = '22023';
    end if;
    if p_set_qty is not null then
      if p_type <> 'adjustment' then
        raise exception 'a counted quantity is an adjustment' using errcode = '22023';
      end if;
      if p_set_qty < 0 then
        raise exception 'a count cannot be negative' using errcode = '22023';
      end if;
      v_change := p_set_qty - v_item.qty_on_hand;
    else
      v_change := p_qty_change;
    end if;
    if v_change is null then
      raise exception 'quantity required' using errcode = '22023';
    end if;
    if p_type in ('initial_count', 'received') and v_change <= 0 then
      raise exception '% needs a positive quantity', p_type using errcode = '22023';
    end if;
    if p_type in ('scanned_out', 'sold', 'disposed') and v_change >= 0 then
      raise exception '% needs a negative quantity', p_type using errcode = '22023';
    end if;
    if v_item.qty_on_hand + v_change < 0 and not (p_allow_negative and p_type = 'scanned_out') then
      raise exception 'only % on hand', v_item.qty_on_hand using errcode = '22023';
    end if;
  end if;

  v_result := v_item.qty_on_hand + v_change;
  -- Selling / disposing comes out of the surplus first; and surplus can never
  -- exceed what is left on hand.
  v_surplus := v_item.surplus_qty;
  if p_type in ('sold', 'disposed') then
    v_surplus := greatest(v_surplus + v_change, 0);
  end if;
  v_surplus := least(v_surplus, greatest(v_result, 0));

  insert into inventory_transactions
    (item_id, unit_id, txn_type, qty_change, resulting_qty, actor_id, occurred_at,
     job_note, customer_id, note, client_op_id, session_id, source)
  values
    (p_item_id, p_unit_id, p_type, v_change, v_result, p_actor_id, coalesce(p_occurred_at, now()),
     p_job_note, p_customer_id, p_note, p_client_op_id, p_session_id, p_source)
  returning * into v_row;

  perform set_config('inventory.posting', 'on', true);
  update inventory_items
     set qty_on_hand = v_result, surplus_qty = v_surplus,
         last_activity_at = now(), updated_at = now(), updated_by = p_actor_id
   where id = p_item_id;
  perform set_config('inventory.posting', 'off', true);

  return v_row;
exception
  when unique_violation then
    -- A concurrent resend of the same op won the race: hand back its row.
    if p_client_op_id is not null then
      select * into v_existing from inventory_transactions where client_op_id = p_client_op_id;
      if found then return v_existing; end if;
    end if;
    raise;
end;
$$;

-- Post a whole count session in one transaction, one row per non-serialized
-- line (serialized units were posted as they were scanned):
--   mode 'add'     -> 'initial_count' of the counted qty (skipped when 0)
--   mode 'replace' -> 'adjustment' that SETS the qty to the counted qty
-- Idempotent: an already-posted session returns 0.
create or replace function public.inventory_post_count_session(p_session_id uuid, p_actor_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.inventory_count_sessions;
  v_line    record;
  v_posted  integer := 0;
begin
  select * into v_session from inventory_count_sessions where id = p_session_id for update;
  if not found then
    raise exception 'count session % not found', p_session_id using errcode = 'P0002';
  end if;
  if v_session.status = 'posted' then return 0; end if;
  if v_session.status <> 'open' then
    raise exception 'count session is %', v_session.status using errcode = '22023';
  end if;

  for v_line in
    select l.item_id, l.counted_qty, l.mode
      from inventory_count_lines l
      join inventory_items i on i.id = l.item_id
     where l.session_id = p_session_id and not i.serialized
       and (l.counted_qty > 0 or l.mode = 'replace')
     order by l.item_id
  loop
    if v_line.mode = 'replace' then
      perform inventory_post_txn(
        p_item_id      => v_line.item_id,
        p_type         => 'adjustment',
        p_actor_id     => p_actor_id,
        p_set_qty      => v_line.counted_qty,
        p_client_op_id => md5(p_session_id::text || ':' || v_line.item_id::text)::uuid,
        p_session_id   => p_session_id,
        p_note         => 'count session: replaced the earlier count',
        p_source       => 'count_session');
    else
      perform inventory_post_txn(
        p_item_id      => v_line.item_id,
        p_type         => 'initial_count',
        p_actor_id     => p_actor_id,
        p_qty_change   => v_line.counted_qty,
        p_client_op_id => md5(p_session_id::text || ':' || v_line.item_id::text)::uuid,
        p_session_id   => p_session_id,
        p_source       => 'count_session');
    end if;
    v_posted := v_posted + 1;
  end loop;

  update inventory_count_sessions set status = 'posted', finished_at = now() where id = p_session_id;
  return v_posted;
end;
$$;

revoke all on function public.inventory_guard() from public, anon, authenticated;
revoke all on function public.inventory_post_txn(uuid, text, uuid, numeric, numeric, uuid, uuid, uuid, text, uuid, text, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.inventory_post_count_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.inventory_post_txn(uuid, text, uuid, numeric, numeric, uuid, uuid, uuid, text, uuid, text, timestamptz, text, boolean) to service_role;
grant execute on function public.inventory_post_count_session(uuid, uuid) to service_role;

-- ============================================================================
-- 8. Member permissions (NULL = role default, see header)
-- ============================================================================
alter table public.member_permissions
  add column if not exists inventory_view boolean,      -- look up stock
  add column if not exists inventory_scan_out boolean,  -- scan items out
  add column if not exists inventory_manage boolean;    -- add / receive / count / adjust / edit / photos / surplus

-- ============================================================================
-- 9. Lock the tables down - backend service role only
-- ============================================================================
alter table public.inventory_items enable row level security;
revoke all on public.inventory_items from anon, authenticated;
alter table public.inventory_barcodes enable row level security;
revoke all on public.inventory_barcodes from anon, authenticated;
alter table public.inventory_units enable row level security;
revoke all on public.inventory_units from anon, authenticated;
alter table public.inventory_photos enable row level security;
revoke all on public.inventory_photos from anon, authenticated;
alter table public.inventory_count_sessions enable row level security;
revoke all on public.inventory_count_sessions from anon, authenticated;
alter table public.inventory_count_lines enable row level security;
revoke all on public.inventory_count_lines from anon, authenticated;
alter table public.inventory_transactions enable row level security;
revoke all on public.inventory_transactions from anon, authenticated;

-- ============================================================================
-- 10. Private photo bucket (no storage policies: service role only)
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inventory-photos', 'inventory-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
