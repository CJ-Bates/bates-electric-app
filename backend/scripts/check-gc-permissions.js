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
    '/subscriptions/:id/portal-session',
    '/subscriptions/:id/resend-welcome',
  ],
  'visits.js': ['/visits/:id/complete', '/visits/:id/schedule'],
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
