require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./routes/auth');
const inspectionRoutes = require('./routes/inspections');
const generatorWebhookRouter = require('./routes/generator-webhook');
const generatorCareRouter = require('./routes/generator-care');
const generatorTechRouter = require('./routes/generator-tech');
const generatorCareCronRouter = require('./routes/generator-care-cron');
const generatorCarePublicRouter = require('./routes/generator-care-public');
const customerRouter = require('./routes/customer');
const membersRouter = require('./routes/members');
const smsInboundRouter = require('./routes/sms-inbound');
const magicShortlinkRouter = require('./routes/magic-shortlink');
const { errorReporter, initSentry } = require('./middleware/error-reporter');
const { requireAuth } = require('./middleware/auth');
const { CONTACTS_DIRECTORY } = require('./lib/contactsDirectory');

// Initialize Sentry as early as possible, gated on the env var so it's a no-op
// until SENTRY_DSN is set in Render. The require lives inside initSentry() and
// is guarded, so a missing @sentry/node module can't crash boot.
if (process.env.SENTRY_DSN) initSentry();

const app = express();
const PORT = process.env.PORT || 3000;

// We run behind Render's proxy: trust exactly one hop so req.ip is the real
// client IP (required for per-IP rate limiting), not the proxy's.
app.set('trust proxy', 1);

// Security headers. CSP is disabled here because this Express app also serves the
// PWA static files below, whose inline scripts/styles a default CSP would break;
// the static signup site sets its own CSP at the Netlify edge. Frame embedding denied.
app.use(helmet({ contentSecurityPolicy: false, frameguard: { action: 'deny' } }));

// CORS restricted to our own origins. Auth is a bearer token (no cookies), so
// requests with no Origin header (Stripe webhook, cron-job.org, curl, server-to-
// server) are allowed; cross-origin browser requests from anywhere else are not.
const ALLOWED_ORIGINS = [
  'https://app.bates-electric.com',
  'https://my.bates-electric.com', // customer portal (Generator Care dashboard)
  'https://generator.bates-electric.com',
  'https://bates-electric-app.netlify.app',
  'https://bates-generator.netlify.app',
];
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true); // local dev
    return cb(null, false);
  },
}));

// Stripe webhook must receive raw body for signature verification
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), generatorWebhookRouter);

// Inspections get a tighter JSON body cap than the global 10mb: the form blob
// is small text and photos upload directly to Supabase storage, not through
// this API. Mounted BEFORE the global parser so this limit is the one applied.
app.use('/inspections', express.json({ limit: '1mb' }), inspectionRoutes);

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'Bates Electric API is running!',
    timestamp: new Date().toISOString(),
  });
});

app.get('/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// Internal team directory for the Contacts page. Any authenticated user
// (office or tech) may read it; it is deliberately NOT in the static HTML so
// names/emails aren't public. Data lives in lib/contactsDirectory.js.
app.get('/contacts-directory', requireAuth, (req, res) => {
  res.json({ directory: CONTACTS_DIRECTORY });
});

// Public (no-auth) Generator Care routes — the email unsubscribe link (WP4).
// Deliberately outside the /api/generator-care office router: the URL lives
// in a customer's inbox and must work with no session. Token-only lookups,
// opt-out-only writes; see routes/generator-care-public.js.
app.use('/generator-care', generatorCarePublicRouter);

// Public (no-auth) SMS short-link redeemer — the /s/<token> URL from the
// auto-login nudge text. Single-use, rate-limited, redirect-only; see
// routes/magic-shortlink.js. my.bates-electric.com/s/* proxies here via
// frontend/_redirects.
app.use('/s', magicShortlinkRouter);

app.use('/auth', authRoutes);
// GET /me lives on the auth router but is commonly called without the prefix;
// mount it there as well for convenience.
app.use('/', authRoutes);

// Serve the frontend as static files (after API routes so they take priority)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Tech router BEFORE the office router: both share the /api/generator-care prefix,
// but /tech/* is tech-gated and must not be shadowed by the office router's
// office-only middleware.
app.use('/api/generator-care/tech', generatorTechRouter);
app.use('/api/generator-care', generatorCareRouter);
app.use('/api/cron/generator-care', generatorCareCronRouter);
// Customer Dashboard v1 (my.html) — customer-role-gated, read-mostly portal.
app.use('/api/my', customerRouter);
// SimpleTexting inbound-SMS webhook — public by necessity (the provider can't
// authenticate), but shared-secret-verified + rate-limited inside the router.
app.use('/api/sms', smsInboundRouter);
// Member management (Members page) — admin-gated inside the router.
app.use('/api/members', membersRouter);

// Global error handler -- mounted LAST so it catches errors from every route
// above (including the generator-care + cron routers). Logs + optional Sentry
// + optional email alert, then returns a generic 500 without leaking the stack.
app.use(errorReporter);

app.listen(PORT, () => {
  console.log(`Bates Electric backend running on port ${PORT}`);
});
