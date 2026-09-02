# backend/routes/generator-care

Office dashboard API for the Generator Care program. Every sub-router here
runs on `supabaseAdmin` (service role) via `index.js`'s
`router.use(requireAuth, requireRole('office'))` — **RLS does not apply to
any query in this directory.** See `backend/docs/authz.md` for why that
matters and how the other GC surfaces (tech, customer, webhook) compare.

## Before you add or change a route here that touches money or customer data

- [ ] Does it declare `requirePermission('<flag>')` (`accounting`, `refunds`,
      `billing_actions`, `customer_edit`, `tech_manage`) for the specific
      action, not just relying on `requireRole('office')`? `requireRole` only
      proves the caller is *some* office account — every office member passes
      it regardless of their permission flags.
- [ ] If it's genuinely fine to skip a granular flag (pure internal-ops
      tracking, resending something already sent, a read-only preview), is
      that actually true — does the route avoid moving money, creating a
      Stripe session/charge, or exposing another customer's data by id?
      (Existing examples that intentionally skip it: work-order-created/undo,
      tier-change-preview, resend-receipt, resend-welcome,
      visit complete/schedule, admin send-test-email — all internal-ops or
      resend actions, none of them mutate billing or cross a customer
      boundary. portal-session used to be on this list but now requires
      `billing_actions`: a Billing Portal session URL is a bearer credential
      for the customer's billing — see `backend/docs/authz.md`.)
- [ ] Does it avoid returning raw `supabaseAdmin` query results without an
      explicit filter/ownership check first? There's no RLS backstop if a
      `.eq(...)` filter is missing or wrong.
- [ ] Does the response keep Stripe internal ids (payment intent ids, raw
      invoice objects), internal notes, and other office-only fields off
      anything that could reach a customer- or tech-facing response shape?
- [ ] If the route resolves a customer/subscription/visit from the request,
      does it use the `:id` in the URL consistently rather than trusting a
      second id embedded in the body that could point somewhere else?

When in doubt, add the permission check — a route that's slightly too
strict is a support ticket; a route that's too loose is a data breach.
