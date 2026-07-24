// Non-blocking scan: flags mutating routes in routes/generator-care/* that
// declare no requirePermission(...) middleware. Never fails the build — this
// is a prompt to double-check, not a gate. RLS does not protect these routes
// (see backend/docs/authz.md), so a missing permission check is a real gap;
// some routes skip it on purpose (see ALLOWLIST below and
// backend/routes/generator-care/README.md).
//
// Static/textual only — reads source, makes no network calls, never writes.
// Run from the backend folder: node scripts/check-gc-permissions.js

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes', 'generator-care');

// file -> route paths intentionally left at requireRole('office') alone.
// Add an entry here (with why) when a new route deliberately skips
// requirePermission; remove it if the route later gains a flag.
const ALLOWLIST = {
  'admin.js': ['/admin/send-test-email'],
  'subscriptions.js': [
    '/subscriptions/:id/work-order-created',
    '/subscriptions/:id/work-order-created/undo',
    '/subscriptions/:id/tier-change-preview',
    '/subscriptions/:id/resend-receipt',
    // portal-session now requires billing_actions (a Portal session URL is a
    // bearer credential for the customer's billing) — no longer a no-flag route.
    '/subscriptions/:id/resend-welcome',
  ],
  'visits.js': ['/visits/:id/complete', '/visits/:id/schedule'],
  // Leads are prospect tracking the whole office works: no money moved, no
  // Stripe objects created, no existing customer's data exposed by id
  // (convert only records a subscription id on the lead row; send-signup and
  // send-invites only email prospects a public signup URL — send-invites is
  // additionally hard-capped at 100 sends per call and skips opted-out or
  // already-invited leads by id re-validation).
  // '/leads/:id' covers BOTH the PATCH edit and the WP4.2 DELETE hard delete
  // (this scan matches by path, not method). Delete is deliberately
  // office-wide too: it removes a prospect row — the worst case is losing a
  // lead's notes/attribution record, never customer or money data — and it's
  // how test/junk rows stay out of pipeline metrics.
  // NOTE: GET /generator-care/unsubscribe (routes/generator-care-public.js,
  // outside this directory) is intentionally UNAUTHENTICATED — it's the link
  // in a customer's inbox. It is token-only and can only set
  // email_opt_out=true; see that file's header comment.
  // NOTE: POST /tech/enroll (routes/generator-tech.js, outside this directory
  // too) is tech-gated (requireAuth + requireRole('tech')) with no granular
  // flag — WP6 field enrollment. Same basis as the leads routes: creates a
  // prospect row + hands out a public signup URL, no money or customer data.
  'leads.js': ['/leads', '/leads/:id', '/leads/:id/convert', '/leads/:id/send-signup', '/leads/send-invites'],
};

const ROUTE_RE = /router\.(post|patch|put|delete)\(\s*(['"])([^'"]+)\2/;

(async () => {
  console.log('\n=== Bates Electric — GC Route Permission Scan (informational, non-blocking) ===\n');

  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js');
  const flagged = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(ROUTE_RE);
      if (!match) continue;
      const [, method, , routePath] = match;
      const hasPermission = line.includes('requirePermission(');
      if (hasPermission) continue;
      if ((ALLOWLIST[file] || []).includes(routePath)) continue;
      flagged.push(`  ${file}  ${method.toUpperCase()} ${routePath}`);
    }
  }

  if (flagged.length === 0) {
    console.log('No un-allowlisted mutating routes without requirePermission(...).\n');
  } else {
    console.log('Mutating routes with no requirePermission(...) and no allowlist entry:');
    for (const line of flagged) console.log(line);
    console.log('\nEach is still gated by requireRole(\'office\') (mounted once in index.js), but');
    console.log('has no granular permission check. Confirm this is intentional, then either add');
    console.log('requirePermission(...) or add it to ALLOWLIST in this script with a reason.\n');
  }
})();
