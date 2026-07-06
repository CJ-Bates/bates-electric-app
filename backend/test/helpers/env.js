// Shared test env bootstrap. Require this FIRST in every test file, before any
// lib module: several lib modules construct clients at require time
// (lib/supabase.js -> createClient, lib/gcShared.js + lib/receipts.js ->
// new Stripe) and throw without these vars. Dummy values only — tests run
// fully offline and must never talk to Supabase, Stripe, or Brevo.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-key';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
// Deliberately NOT setting BREVO_API_KEY: lib/mailer.js fails closed
// ({sent:false}) without it, so an accidental send attempt can't go anywhere.
