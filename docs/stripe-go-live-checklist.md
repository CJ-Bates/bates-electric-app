# Stripe Test → Live Cutover Checklist

**Status:** Draft. Do not execute until reviewed end-to-end.

**One-way door:** once a real customer signs up against live mode, you cannot
roll back without partial-refund / cancellation cleanup. Pre-flight every step.

---

## 0. Architecture facts (so you know what is, and is NOT, in scope)

- **No Stripe publishable key exists anywhere in the codebase.** The bates-generator
  signup page submits the form to Netlify Function [`netlify/functions/create-checkout.js`](../../bates-generator/netlify/functions/create-checkout.js),
  which calls `https://api.stripe.com/v1/checkout/sessions` server-side using
  `STRIPE_SECRET_KEY`, then redirects the browser to the returned `session.url`.
  → **The only key that needs swapping on bates-generator is the Netlify env var
    `STRIPE_SECRET_KEY`.** The CJ Cowork brief's mention of "swap publishable
    key" was based on an older architecture; ignore.
- All product/price IDs are hardcoded in the `CATALOG` constant inside
  `create-checkout.js` (lines 7-34). **Every one of these 14 price IDs must be
  recreated in live mode and the constant updated.**
- The bates-electric-app backend on Render holds two Stripe-related secrets:
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- The webhook endpoint is mounted at `POST /api/webhooks/stripe` on the Render
  service (see [`backend/server.js`](../backend/server.js)). The Stripe dashboard
  needs a NEW endpoint registered against live mode pointing at the same URL.

---

## 1. Pre-flight in test mode (verify everything works BEFORE flipping)

- [ ] Send each transactional email through the admin endpoint (commit `4a3f50c`),
  verify rendering in a real inbox (Gmail + Outlook ideally):
  ```bash
  curl -X POST https://app.bates-electric.com/api/generator-care/admin/send-test-email \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"template":"welcome","to":"amyp@bates-electric.com"}'
  # repeat for "failed_charge" and "portal_link"
  ```
- [ ] In test mode, complete a fresh signup with a card that triggers the welcome
  flow. Confirm the customer row, subscription row, first service visit row,
  pending addons rows, and welcome email all land.
- [ ] In test mode, trigger a card-failed event (Stripe Dashboard → test webhook
  resend, or use a [test card that auto-declines](https://docs.stripe.com/testing#cards-responses))
  and confirm the auto-portal-link email fires.
- [ ] Verify the Customer Portal session minting works: from a customer detail
  modal, click "Send Card-Update Link". Confirm the email lands and the link
  opens a live Stripe portal page.
- [ ] **Fix the ATS addon name mismatch** (independent bug found while writing
  this checklist):
  - bates-generator/index.html line 833 sends `ats_outage_combined` to the
    Netlify function
  - bates-generator/netlify/functions/create-checkout.js CATALOG has keys
    `ats_inspection` and `outage_test` but NOT `ats_outage_combined`
  - Result: signups that select the ATS addon currently DO NOT add the addon
    line item to the Stripe checkout session (the lookup returns undefined and
    the addon is silently skipped). The customer gets the base plan only.
  - Recommend: rename CATALOG key from `ats_inspection` to `ats_outage_combined`
    and confirm the price is the $110 combined price, then re-test.

## 2. Live-mode setup in Stripe Dashboard (no key flips yet)

- [ ] Switch Stripe dashboard to **Live mode** (toggle, top right).
- [ ] **Recreate all 14 products + prices** to mirror the CATALOG in
  `bates-generator/netlify/functions/create-checkout.js`. Use the same names
  and intervals; save each new `price_…` ID.
  - 6 subscription prices: air_cooled × {semi_annual, annual}, liquid_22_38 ×
    {semi_annual, annual}, liquid_48_150 × {semi_annual, annual}
  - 2 recurring add-on prices: fleet_monitoring × {semi_annual, annual}
  - 6 one-time add-on prices: battery_diagnostics, exterior_wash, outage_test,
    ats_inspection (or ats_outage_combined per fix above), battery_replacement
    × {air_cooled, liquid_22_38, liquid_48_150}, coolant_flush ×
    {liquid_22_38, liquid_48_150}
  - **Verify each amount matches the test-mode product before saving.** Easy
    mistake: typo a cent value.
- [ ] **Configure the Customer Portal** in Live mode
  (Stripe Dashboard → Settings → Billing → Customer Portal). Match the
  test-mode config: enable card updates, invoice history, subscription
  cancellation? (whatever you have in test today).
- [ ] **Register the live webhook endpoint** (Stripe Dashboard → Developers
  → Webhooks → Add endpoint, in Live mode):
  - URL: `https://<render-service-domain>/api/webhooks/stripe` (same as test)
  - Events to listen for — copy the exact event list from the test-mode
    endpoint config. At minimum: `customer.subscription.created`,
    `customer.subscription.updated`, `customer.subscription.deleted`,
    `invoice.paid`, `invoice.payment_failed`, plus any others currently
    registered in test.
  - After saving, copy the signing secret (`whsec_…`) — you'll paste it as
    the new `STRIPE_WEBHOOK_SECRET` env var in step 4.
- [ ] Grab the live secret key (Stripe Dashboard → Developers → API keys →
  Standard keys, **Live mode**, click "Reveal" on the secret key). You'll use
  it as `STRIPE_SECRET_KEY` on both Render and Netlify in step 4.

## 3. Code prep (don't deploy yet)

- [ ] Update `bates-generator/netlify/functions/create-checkout.js` CATALOG
  constant to use the new live `price_…` IDs from step 2. Easiest workflow:
  open the file alongside the new Stripe Live products page and copy each ID
  across in order.
- [ ] **Do not commit a hardcoded secret key anywhere.** All secrets stay in
  Netlify/Render env vars only.
- [ ] Diff the CATALOG change carefully — a wrong price ID is the most
  likely cause of "signup succeeds but charges the wrong amount" disasters.

## 4. Env var swaps (the actual cutover)

This is the moment of no return. Do these in the order below, in one tight
sitting (5-10 min) so the window where keys are mismatched is minimal.

- [ ] **Render** (bates-electric-app): set `STRIPE_SECRET_KEY` to the new
  live `sk_live_…`. Render env-var changes trigger a redeploy automatically
  (~3 min). Do NOT change `STRIPE_WEBHOOK_SECRET` yet (the test webhook is
  still active and the live one isn't registered until next bullet).
- [ ] **Render** (bates-electric-app): set `STRIPE_WEBHOOK_SECRET` to the
  new live `whsec_…` from step 2's webhook registration. Trigger redeploy.
  Now the live webhook will be accepted and the test webhook will be
  rejected (signature mismatch).
- [ ] **Netlify** (bates-generator): set `STRIPE_SECRET_KEY` to the same new
  live `sk_live_…`. Trigger a redeploy. Netlify rebuilds the function
  bundle (~30-60 s).
- [ ] **Deploy the bates-generator CATALOG update** from step 3 (git push to
  main; Netlify auto-deploys).
- [ ] **Disable the test-mode webhook** in the Stripe Dashboard (Test mode →
  Webhooks → toggle off, or delete). Prevents stale test-mode events from
  hitting the production handler with the old `whsec_…` and being rejected
  loudly.

## 5. Post-cutover verification (within 30 min)

- [ ] In Stripe Dashboard, confirm you're now viewing **Live mode** and the
  new webhook endpoint shows zero failed deliveries.
- [ ] Do a real end-to-end test signup with your own card on
  `https://generator.bates-electric.com`. Use the smallest plan ($X
  semi-annual). Confirm:
  - Stripe Checkout uses live products
  - Welcome email lands
  - Customer row + subscription row + first service visit row land in Supabase
  - Webhook delivery shows 200 in Stripe Dashboard
- [ ] In the app dashboard, immediately cancel the test subscription and
  refund the charge from the Stripe Dashboard. Note for the books: this
  test customer should be flagged in the generator_customers table so Amy
  doesn't try to schedule a visit.
- [ ] Send a `[TEST] welcome` admin email and confirm the From address is
  still `no-reply@bates-electric.com` (env var GENERATOR_DIGEST_FROM
  unchanged).
- [ ] Update the cron job at cron-job.org to confirm the daily digest still
  fires at 6 AM Central (nothing should change here — the cron is
  independent of Stripe — but check tomorrow morning anyway).

## 6. Rollback plan

If anything breaks in the first hour and you haven't yet had a real customer
signup:
1. Render: revert `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to the
   previous test values. Redeploy.
2. Netlify (bates-generator): revert `STRIPE_SECRET_KEY` to test value,
   and `git revert` the CATALOG-IDs commit. Redeploy.
3. Re-enable the test-mode webhook in Stripe Dashboard.

If a real customer has already signed up: you cannot truly roll back without
manually refunding and cancelling them. The right move is to fix forward —
diagnose and patch the live config.

## 7. After the smoke clears

- [ ] Update the brief / CLAUDE.md to note Stripe is in live mode now.
- [ ] Remove this checklist's "Status: Draft" header and date the cutover.
- [ ] Tell Amy. She is the one who will field the first real-customer support
  call if anything's off.
