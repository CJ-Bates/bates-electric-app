-- Bates Electric - Generator Care program
-- Migration 005: capture columns for the Metrics / Insights dashboard
--
-- Adds three nullable columns to generator_subscriptions:
--   * signup_source     - "How did you hear about us?" answer from the signup
--                         page (free-form-ish; values come from a fixed dropdown
--                         but stored as text so the list can change without a
--                         migration). NULL for every subscription created before
--                         this migration ships -- the metrics view labels the
--                         channel breakdown "collecting since <date>" and never
--                         backfills/fabricates historical channel data.
--   * signup_utm_source - utm_source query param captured at signup, if present
--                         (lets QR codes / email links self-attribute). NULL when
--                         the visitor arrived without a utm_source.
--   * canceled_at       - timestamp a subscription was marked canceled. There was
--                         no cancellation timestamp before this; the cancel paths
--                         (webhook + dashboard endpoint) only set status. Without
--                         it, "canceled this month" and the canceled trend can't
--                         be computed. Set going forward by both cancel paths;
--                         historical cancels stay NULL (trend is "since <date>").
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS (PG 15) and CREATE INDEX IF NOT
-- EXISTS. No data is modified.

-- ============================================================
-- Columns
-- ============================================================

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS signup_source text;

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS signup_utm_source text;

ALTER TABLE public.generator_subscriptions
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

-- ============================================================
-- Indexes
-- ============================================================

-- Channel breakdown groups active/in-range signups by signup_source.
CREATE INDEX IF NOT EXISTS generator_subs_signup_source_idx
  ON public.generator_subscriptions USING btree (signup_source)
  WHERE (signup_source IS NOT NULL);

-- Canceled-in-range / churn-trend queries filter by canceled_at.
CREATE INDEX IF NOT EXISTS generator_subs_canceled_at_idx
  ON public.generator_subscriptions USING btree (canceled_at)
  WHERE (canceled_at IS NOT NULL);
