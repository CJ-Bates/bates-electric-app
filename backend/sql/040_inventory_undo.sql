-- 040_inventory_undo.sql
-- Undo for warehouse inventory (CJ's first real-phone test, 2026-10-30: he
-- tapped "+ In" by accident and there was no way back).
--
-- An undo is a NEW ledger row - the ledger stays append-only and the history
-- shows both rows:
--   1. inventory_transactions.reverses_txn_id: the row an undo reverses.
--      A partial unique index allows at most ONE undo per row (a double tap
--      or an offline resend can't undo twice).
--   2. inventory_post_txn() gains p_reverses_txn_id. With it, the function
--      locks the original row and posts an 'adjustment' of the opposite
--      quantity (note set by the caller, e.g. "undo of received"):
--        - non-serialized: qty_change = -original.qty_change (refused, like
--          any adjustment, if it would take stock below zero - e.g. undoing
--          a receive whose parts already went out)
--        - serialized: the UNIT moves back - an undone scan-out puts the
--          unit back in stock; an undone receive takes it out of stock
--          ('out' if it had history before, else 'pending')
--        - an undo can't itself be undone; a second undo of the same row
--          returns the first one (idempotent)
--      Who may undo what (own action, most recent, 15 minutes) is checked
--      in routes/inventory.js before calling this.
--   The function's signature changes (one more parameter), so the old
--   version is dropped first: two overloads would make PostgREST's named-
--   argument call ambiguous. inventory_post_count_session() calls it by
--   name with named arguments and needs no change.
--
-- After running, record it in the ledger (see backend/sql/README.md):
--   insert into public.schema_migrations (id) values ('040_inventory_undo.sql') on conflict do nothing;
--
-- VERIFY after running. Expected: reverses_column=1, reverses_index=1,
-- post_txn_versions=1, post_txn_has_reverses=1, function_client_grants=0,
-- ledger_mismatches=0:
--   select
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'inventory_transactions'
--          and column_name = 'reverses_txn_id') as reverses_column,
--     (select count(*) from pg_indexes
--        where schemaname = 'public' and indexname = 'inventory_txn_reverses_key') as reverses_index,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname = 'inventory_post_txn') as post_txn_versions,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname = 'inventory_post_txn'
--          and 'p_reverses_txn_id' = any(p.proargnames)) as post_txn_has_reverses,
--     (select count(*) from information_schema.routine_privileges
--        where routine_schema = 'public' and routine_name like 'inventory\_%'
--          and grantee in ('PUBLIC','anon','authenticated')) as function_client_grants,
--     (select count(*) from public.inventory_items i
--        where i.qty_on_hand <> coalesce((select sum(t.qty_change) from public.inventory_transactions t
--                                          where t.item_id = i.id), 0)) as ledger_mismatches;

-- ============================================================================
-- 1. The link + one undo per row
-- ============================================================================
alter table public.inventory_transactions
  add column if not exists reverses_txn_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_reverses_fk') then
    alter table public.inventory_transactions
      add constraint inventory_transactions_reverses_fk
      foreign key (reverses_txn_id) references public.inventory_transactions(id) on delete restrict;
  end if;
end $$;

create unique index if not exists inventory_txn_reverses_key
  on public.inventory_transactions (reverses_txn_id)
  where reverses_txn_id is not null;

-- ============================================================================
-- 2. inventory_post_txn() with p_reverses_txn_id
-- ============================================================================
drop function if exists public.inventory_post_txn(uuid, text, uuid, numeric, numeric, uuid, uuid, uuid, text, uuid, text, timestamptz, text, boolean);

create or replace function public.inventory_post_txn(
  p_item_id         uuid,
  p_type            text,
  p_actor_id        uuid,
  p_qty_change      numeric default null,
  p_set_qty         numeric default null,
  p_unit_id         uuid default null,
  p_client_op_id    uuid default null,
  p_session_id      uuid default null,
  p_job_note        text default null,
  p_customer_id     uuid default null,
  p_note            text default null,
  p_occurred_at     timestamptz default null,
  p_source          text default null,
  p_allow_negative  boolean default false,
  p_reverses_txn_id uuid default null
)
returns public.inventory_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.inventory_transactions;
  v_orig     public.inventory_transactions;
  v_item     public.inventory_items;
  v_unit     public.inventory_units;
  v_change   numeric(12,2);
  v_result   numeric(12,2);
  v_status   text;
  v_surplus  numeric(12,2);
  v_unit_id  uuid := p_unit_id;
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

  if p_reverses_txn_id is not null then
    -- ---- Undo: reverse one earlier row ----
    if p_type <> 'adjustment' then
      raise exception 'an undo is posted as an adjustment' using errcode = '22023';
    end if;
    select * into v_orig from inventory_transactions where id = p_reverses_txn_id for update;
    if not found then
      raise exception 'nothing to undo' using errcode = 'P0002';
    end if;
    if v_orig.item_id <> p_item_id then
      raise exception 'that change belongs to another item' using errcode = '22023';
    end if;
    if v_orig.reverses_txn_id is not null then
      raise exception 'an undo can''t be undone' using errcode = '22023';
    end if;
    select * into v_existing from inventory_transactions where reverses_txn_id = p_reverses_txn_id;
    if found then return v_existing; end if;

    if v_orig.unit_id is not null then
      v_unit_id := v_orig.unit_id;
      select * into v_unit from inventory_units where id = v_unit_id for update;
      if v_orig.qty_change > 0 then
        -- undo a receive / count of this unit: take it back out of stock
        if v_unit.status <> 'in_stock' then
          raise exception 'unit % is no longer in stock', v_unit.serial_number using errcode = '22023';
        end if;
        v_status := case when exists (
            select 1 from inventory_transactions
             where unit_id = v_unit_id and id <> v_orig.id and created_at < v_orig.created_at)
          then 'out' else 'pending' end;
        v_change := -1;
      else
        -- undo a scan-out / sale / disposal of this unit: back in stock
        if v_unit.status = 'in_stock' then
          raise exception 'unit % is already back in stock', v_unit.serial_number using errcode = '22023';
        end if;
        v_status := 'in_stock';
        v_change := 1;
      end if;
      update inventory_units set status = v_status, updated_at = now() where id = v_unit_id;
    else
      v_change := -v_orig.qty_change;
      if v_item.qty_on_hand + v_change < 0 then
        raise exception 'only % on hand - can''t undo', v_item.qty_on_hand using errcode = '22023';
      end if;
    end if;

  elsif v_item.serialized then
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
  v_surplus := v_item.surplus_qty;
  if p_type in ('sold', 'disposed') then
    v_surplus := greatest(v_surplus + v_change, 0);
  end if;
  v_surplus := least(v_surplus, greatest(v_result, 0));

  insert into inventory_transactions
    (item_id, unit_id, txn_type, qty_change, resulting_qty, actor_id, occurred_at,
     job_note, customer_id, note, client_op_id, session_id, source, reverses_txn_id)
  values
    (p_item_id, v_unit_id, p_type, v_change, v_result, p_actor_id, coalesce(p_occurred_at, now()),
     p_job_note, p_customer_id, p_note, p_client_op_id, p_session_id, p_source, p_reverses_txn_id)
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
    -- A concurrent resend (same op) or a concurrent second undo won the race.
    if p_client_op_id is not null then
      select * into v_existing from inventory_transactions where client_op_id = p_client_op_id;
      if found then return v_existing; end if;
    end if;
    if p_reverses_txn_id is not null then
      select * into v_existing from inventory_transactions where reverses_txn_id = p_reverses_txn_id;
      if found then return v_existing; end if;
    end if;
    raise;
end;
$$;

revoke all on function public.inventory_post_txn(uuid, text, uuid, numeric, numeric, uuid, uuid, uuid, text, uuid, text, timestamptz, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.inventory_post_txn(uuid, text, uuid, numeric, numeric, uuid, uuid, uuid, text, uuid, text, timestamptz, text, boolean, uuid) to service_role;
