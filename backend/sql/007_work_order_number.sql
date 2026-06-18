-- Bates Electric - Generator Care program
-- Migration 007: capture the Jonas work-order number on the hand-off
--
-- When the office marks a work order created, they enter the Jonas WO number so
-- the AR "ready to invoice" email includes it (AR uses it to pull the order up
-- in Jonas) and it stays visible on the customer's hand-off card afterward.
--   * work_order_number - the Jonas work-order number (free text; Jonas formats
--                         vary), entered at "Mark work order created" time.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS (PG 15). No data is modified.

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS work_order_number text;
