# Stripe Test → Live Cutover Checklist

**Status:** Draft. Review end-to-end before executing.

**One-way door:** once a real customer signs up against live mode, you cannot
roll back without partial-refund / cancellation cleanup. Pre-flight every step.

**Last reviewed:** 2026-06-08

---

## 0. Architecture facts (so you don't waste time on non-existent steps)

- **There is no Stripe publishable key in this codebase. None. Anywhere.**
  Customer signups at generator.bates-electric.com submit the form to Netlify
  Function [`netlify/functions/create-checkout.js`](../../bates-generator/netlify/functions/create-checkout.js),
  which calls `https://api.stripe.com/v1/checkout/sessions` server-side using
  `STRIPE_SECRET_KEY`, then redirects the browser to the returned
  Stripe-hosted `session.url`. The browser never holds a Stripe key.
  → **No "publishable-key swap" step exists. The only Stripe secret on
    Netlify is `STRIPE_SECRET_KEY`.**
- All product/price IDs are hardcoded in the `CATALOG` constant inside
  `create-checkout.js`. **17 unique Stripe prices** (18 entries; coolant_topoff
  reuses one across both liquid tiers) must be recreated in live mode and
  the CATALOG updated.
- bates-electric-app backend on Render holds two Stripe-related secrets:
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- The webhook endpoint is mounted at **`POST /webhooks/stripe`** on the Render
  service ([`backend/server.js:17`](../backend/server.js#L17)). Public URL:
  `https://bates-electric-app.onrender.com/webhooks/stripe`. The Stripe
  Dashboard needs a NEW endpoint registered against live mode pointing at
  that URL.
- Supabase project ref `veiunqctijuzirvpsqkg`. Migrations 002 (generator
  schema) and 004 (past_due status) are already applied to this project
  as of 2026-06-08. No DB migrations are needed for the live cutover.

---

## 1. Pre-flight in test mode (verify everything works BEFORE flipping)

### 1a. All five customer-facing emails render correctly

Fire each from the dashboard Admin Tools panel
(generator-care.html → "Admin tools" → "Send test email"). Visually verify in
both Gmail and Outlook if possible.

- [ ] `welcome`
- [ ] `visit_scheduled`
- [ ] `visit_complete`
- [ ] `failed_charge` (CTA link will 404 — expected, it's a placeholder
      Stripe session ID for previews)
- [ ] `portal_link` (same — CTA link will 404 by design)

### 1b. End-to-end test signup → welcome flow

- [ ] Use [generator.bates-electric.com](https://generator.bates-electric.com)
      to complete a fresh test-mode signup with a successful test card
      (`4242 4242 4242 4242`).
- [ ] Verify in Supabase Studio (`generator_*` tables):
  - `generator_customers` row created with the right email, phone, install
    address fields.
  - `generator_subscriptions` row with `status='active'`, correct
    `annual_price_cents`, correct `plan`, and `raw_metadata` containing the
    addon JSON.
  - `generator_service_visits` row with `status='tentative'` and
    `scheduled_date` set to today.
  - `generator_pending_addons` rows for any on-demand addons selected
    (especially the recently wired-up `ats_outage_combined` and
    `coolant_topoff`).
- [ ] Welcome email lands in the inbox of the address used at signup.

### 1c. Webhook event coverage (new in 073d493 — verify before live)

- [ ] In Stripe Dashboard (test mode), find the test customer's subscription
      and click "Cancel subscription" → "at end of period". Within seconds,
      Supabase `generator_subscriptions.status` should flip to `canceled`
      (the `customer.subscription.updated` handler with `cancel_at_period_end`).
- [ ] Reactivate the subscription (Stripe Dashboard → "Don't cancel"). Status
      should flip back to `active`.
- [ ] Use the Customer Portal (mint a session via "Send Card-Update Link" on
      the office dashboard, open the URL) to change the customer's email.
      Within seconds, `generator_customers.email` should sync to the new value.

### 1d. Past-due renewal detection

- [ ] Optional but valuable: trigger a renewal failure in test mode by using
      Stripe's test card `4000 0000 0000 0341` (charge succeeds at signup,
      fails on renewal). Advance the subscription using Stripe Dashboard
      "Advance test clock" or wait for the next renewal cycle. Confirm:
  - `generator_subscriptions.status` flips to `past_due` (via
    `customer.subscription.updated`).
  - The customer receives the card-failed email with portal link.
  - The next daily digest includes a "Past-due renewals" section at the top.

### 1e. Visit-lifecycle emails (new in 6e420b3)

- [ ] On the office dashboard, mark the test signup's tentative first visit as
      "Confirm". Customer should receive the "Your generator service visit is
      confirmed" email.
- [ ] Mark the visit as "Mark complete" with a note. Customer should receive
      the "Your generator service visit is complete" email with the note
      embedded.

### 1f. Daily digest

- [ ] Manually trigger the cron endpoint with the shared secret:
      ```bash
      curl -X POST https://bates-electric-app.onrender.com/api/cron/generator-care/daily-email \
        -H "Authorization: Bearer $CRON_SECRET"
      ```
      Confirm amyp@ + cjbates@ receive the digest and that any past-due,
      overdue, tentative, and confirmed sections all render.

---

## 2. Live-mode setup in Stripe Dashboard (no key flips yet)

- [ ] Switch Stripe Dashboard to **Live mode** (toggle, top right).
- [ ] **Recreate all 17 unique products + prices** to mirror the CATALOG in
      `bates-generator/netlify/functions/create-checkout.js`. Use the same
      product names and intervals. Verify each amount matches the test-mode
      product before saving — a typo'd cent value is the #1 way to overcharge
      or undercharge customers.

      Full inventory:
  - **6 subscription prices** (recurring):
    - air_cooled × {semi_annual, annual}
    - liquid_22_38 × {semi_annual, annual}
    - liquid_48_150 × {semi_annual, annual}
  - **2 recurring addon prices**:
    - fleet_monitoring × {semi_annual ($32.50/6mo), annual ($65/yr)}
  - **9 one-time addon prices** (charged later off saved card):
    - exterior_wash (1 price, all classes)
    - ats_outage_combined ($110, all classes)
    - coolant_topoff ($95, used for both liquid tiers — create once, reuse)
    - battery_replacement × {air_cooled, liquid_22_38, liquid_48_150}
    - coolant_flush × {liquid_22_38, liquid_48_150}

  Save each new `price_…` ID — you'll paste them into the CATALOG in step 3.

- [ ] **Configure the Customer Portal** in Live mode
      (Dashboard → Settings → Billing → Customer Portal). Match whatever
      you have in test today — at minimum:
  - Card update: enabled
  - Invoice history: enabled
  - Subscription cancellation: enabled (the dashboard cancel flow relies on
    this; if you disable it here you'd block self-service cancellation,
    which is probably fine — but match test mode to avoid surprises).
- [ ] **Register the live webhook endpoint** (Dashboard → Developers →
      Webhooks → Add endpoint, in **Live mode**):
  - URL: `https://bates-electric-app.onrender.com/webhooks/stripe`
  - **Events to listen for** (must match the handler at
    [`backend/routes/generator-webhook.js`](../backend/routes/generator-webhook.js)):
    - `customer.subscription.created`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `customer.updated`
    - `invoice.paid`
    - `invoice.payment_succeeded`
    - `invoice.payment_failed`
  - After saving the endpoint, **copy the signing secret** (`whsec_…`) —
    you'll paste it as the new `STRIPE_WEBHOOK_SECRET` env var in step 4.
- [ ] Grab the live secret key (Dashboard → Developers → API keys → Standard
      keys, **Live mode**, click "Reveal" on the secret key). You'll use it
      as `STRIPE_SECRET_KEY` on both Render and Netlify in step 4.

---

## 3. Code prep (don't deploy yet)

- [ ] Update `bates-generator/netlify/functions/create-checkout.js` CATALOG
      constant to use the new live `price_…` IDs from step 2. Workflow:
      open the file alongside the new Stripe Live products page and copy
      each ID across in the same order. Keep `coolant_topoff` reusing the
      same live price ID across both liquid tiers (don't create two live
      prices for it).
- [ ] **Do not commit a hardcoded secret key anywhere.** All secrets stay in
      Netlify/Render env vars only.
- [ ] Diff the CATALOG change carefully — a wrong price ID is the most likely
      cause of "signup succeeds but charges the wrong amount" disasters.
      Commit but do NOT push to main yet — push happens in step 4 after
      env vars are flipped.

---

## 4. Env var swaps (the actual cutover)

This is the moment of no return. Do these in the order below, in one tight
sitting (5-10 min) so the window where keys are mismatched is minimal.

- [ ] **Stripe Dashboard (Test mode):** disable the test-mode webhook
      endpoint *first*. Otherwise, after you flip the Render
      `STRIPE_WEBHOOK_SECRET` to live, any in-flight test events will hit
      production with the old secret and 500 (Stripe will retry-storm).
- [ ] **Render (bates-electric-app):** set `STRIPE_SECRET_KEY` to the new
      `sk_live_…`. Render env-var changes auto-trigger a redeploy (~3 min).
- [ ] **Render (bates-electric-app):** set `STRIPE_WEBHOOK_SECRET` to the new
      `whsec_…` from step 2. Trigger redeploy if it doesn't auto-trigger.
- [ ] **Netlify (bates-generator):** set `STRIPE_SECRET_KEY` to the same new
      `sk_live_…`. Netlify rebuilds the function bundle (~30-60 s).
- [ ] **Deploy the bates-generator CATALOG update** from step 3:
      `git push origin main` from the bates-generator repo. Netlify
      auto-deploys.
- [ ] Wait for both deploys to complete (Render dashboard shows "Live",
      Netlify dashboard shows "Published"). Don't move to step 5 until
      both are green.

---

## 5. Post-cutover smoke tests (within 30 min)

- [ ] **Stripe Dashboard:** confirm you're now viewing **Live mode** and the
      new webhook endpoint shows zero failed deliveries.
- [ ] **End-to-end live signup with your own card** (will charge real money).
      Use the smallest plan (air_cooled, semi_annual). On
      [generator.bates-electric.com](https://generator.bates-electric.com):
  - Stripe Checkout shows live products with correct amounts.
  - Card is actually charged (check your bank app).
  - Welcome email lands in your inbox.
  - Office dashboard ([app.bates-electric.com/generator-care.html](https://app.bates-electric.com/generator-care.html))
    shows the new customer + subscription + tentative visit.
  - Stripe Dashboard → Webhooks shows the `customer.subscription.created`
    and `invoice.paid` deliveries returned 200.
- [ ] **Test the new subscription.updated handler in live mode:** in Stripe
      Dashboard, click Cancel → "at end of period" on the test sub. Within
      seconds, dashboard should show that customer as canceled.
- [ ] **Refund yourself + cancel the test sub:** from Stripe Dashboard,
      refund the charge (full amount). From the office dashboard, click
      Cancel Subscription. **Mark this customer's row with a clear note in
      the `notes` column** ("CJ test signup — DO NOT SCHEDULE") so Amy
      doesn't dispatch a tech to the wrong address.
- [ ] **Send a live `[TEST] welcome` admin email** via the dashboard Admin
      Tools. Confirm the `From` address is still `no-reply@bates-electric.com`
      (env var `GENERATOR_DIGEST_FROM` should not have been touched during
      the cutover).
- [ ] **Daily digest:** tomorrow at 6 AM Central, check that the cron-job.org
      ping still produces a digest email (no changes here — cron is
      independent of Stripe — but verify nothing got disturbed).

---

## 6. Rollback plan

### If no real customer has signed up yet (first ~hour after cutover)

1. **Stripe Dashboard:** disable the live webhook endpoint, re-enable the
   test webhook endpoint.
2. **Render (bates-electric-app):** revert `STRIPE_SECRET_KEY` and
   `STRIPE_WEBHOOK_SECRET` to the previous test values you saved before
   the cutover. Redeploy.
3. **Netlify (bates-generator):** revert `STRIPE_SECRET_KEY` to the test
   value. `git revert` the CATALOG-IDs commit. Push and redeploy.
4. Confirm you can complete a test signup again and that webhooks land
   in Supabase as test data.

### If a real customer has already signed up

You cannot truly roll back without refunding + cancelling them. The right
move is **fix forward**:

- Diagnose what broke (Render logs, Stripe webhook delivery log, Supabase
  query log).
- Patch in place. The most likely failure modes:
  - **CATALOG price ID typo:** customer was charged the wrong amount. Fix
    the CATALOG, push, then in Stripe Dashboard refund the difference and
    apply a credit or one-off adjustment.
  - **Webhook secret mismatch:** signature verification fails, no DB
    rows get written. Re-copy the signing secret from Stripe Dashboard
    into Render. Stripe auto-retries for ~3 days, so the data will catch up.
  - **Customer Portal config missing in live mode:** "Send Card-Update Link"
    fails with a 500. Configure the portal in live mode, retry.
- Only fall back to refund-and-rollback if the bug is genuinely
  unrecoverable.

---

## 7. After the smoke clears (within 24 hours)

- [ ] **Update CLAUDE.md** to note Stripe is in live mode now. Strike or
      remove any references to "test mode" status.
- [ ] **Update the memory note** at
      `C:/Users/cjbates/.claude/projects/C--Users-cjbates/memory/generator-care-program.md`
      ("Status as of 2026-06-05" section) to reflect the live cutover date.
- [ ] **Remove this checklist's `Status: Draft` header** and add a `Cutover
      completed: YYYY-MM-DD` line at the top.
- [ ] **Tell Amy.** She is the one who will field the first real-customer
      support call if anything's off. Give her a heads-up so she's not
      caught flat-footed by the first signup notification.
- [ ] Watch the Stripe Dashboard webhook delivery log for the first 48
      hours. Any delivery showing > 1 retry is worth investigating.
- [ ] Watch the daily digest for the first week. The first real customer
      will surface in the digest's "Tentative — please confirm" section the
      morning after their signup.

---

## Quick reference: every Stripe / env / config touchpoint

| Where | What | Test value | Live value |
|---|---|---|---|
| Render env | `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_live_…` |
| Render env | `STRIPE_WEBHOOK_SECRET` | `whsec_…` (test) | `whsec_…` (live) |
| Netlify env (bates-generator) | `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_live_…` |
| bates-generator code | CATALOG price IDs | 17 unique `price_…` (test) | 17 unique `price_…` (live) |
| Stripe Dashboard | Products + prices | 17 unique (test mode) | 17 unique (live mode) |
| Stripe Dashboard | Customer Portal config | Set in test | Must replicate in live |
| Stripe Dashboard | Webhook endpoint | URL + 7 events (test) | URL + 7 events (live) |

Not touched during cutover (verify untouched after):
- `SENDGRID_API_KEY`, `GENERATOR_DIGEST_FROM`, `GENERATOR_DIGEST_TO`,
  `CRON_SECRET`, `SUPABASE_*`, `OFFICE_EMAIL`, `GMAIL_USER`.
