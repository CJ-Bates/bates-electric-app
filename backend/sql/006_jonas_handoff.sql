-- Bates Electric - Generator Care program
-- Migration 006: Jonas hand-off tracking (work order + AR invoicing)
--
-- Jonas stays manual (no integration). These columns track the manual hand-off
-- so the dashboard can show a "Signed up -> Work order created -> Invoiced"
-- pipeline and notify AR when a work order is ready to invoice:
--   * work_order_created_at  - when the office marked the Jonas work order created
--                              (also the trigger point for the AR notification).
--   * work_order_created_by  - which office user marked it (name or email).
--   * invoice_sent_at        - when AR's paid invoice was sent (closes the loop).
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS (PG 15). No data is modified.

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS work_order_created_at timestamptz;

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS work_order_created_by text;

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS invoice_sent_at timestamptz;
