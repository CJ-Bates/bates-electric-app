// backend/lib/stripeConfig.js
// The single source of truth for how every Stripe client in the request path is
// constructed, so office (lib/gcShared.js), receipts (lib/receipts.js), and the
// webhook (routes/generator-webhook.js) can't drift apart.
//
// `timeout` is the reliability fix: the stripe-node default is 80s, which on a
// wedged socket means a request hangs for over a minute before failing. Pinning
// it to 20s makes a stuck Stripe call reject quickly (into the try/catch the
// routes already have) instead of tying up a worker. Happy-path calls finish in
// well under 20s, so this never trips on normal load. `maxNetworkRetries: 1`
// keeps a single automatic retry on transient network blips.
//
// `apiVersion` stays pinned to Basil so Stripe behavior can't shift under us on
// an SDK bump (Basil moved the paid-invoice payment shape — see gcShared.js).

const STRIPE_CLIENT_OPTIONS = {
  apiVersion: '2025-08-27.basil',
  timeout: Number(process.env.STRIPE_TIMEOUT_MS) || 20000,
  maxNetworkRetries: 1,
};

module.exports = { STRIPE_CLIENT_OPTIONS };
