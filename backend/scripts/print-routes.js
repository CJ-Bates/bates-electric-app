// Prints every mounted route as "METHOD /full/path", one per line, by walking
// the Express router stacks. Used to prove refactors don't change the route
// table: run before and after, sort, diff — must be identical.
//
// Requires the routers directly (not server.js) so no HTTP listener starts.
// Module-level clients (Stripe) need a key to construct, so dummies are set
// when the real env doesn't provide one — no live calls are ever made.

require('dotenv').config();
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy';

// Mirror of the server.js mounts (prefix -> router module).
const MOUNTS = [
  ['/auth', '../routes/auth'],
  ['', '../routes/auth'], // auth router is also mounted at '/'
  ['/inspections', '../routes/inspections'],
  ['/webhooks/stripe', '../routes/generator-webhook'],
  ['/api/generator-care/tech', '../routes/generator-tech'],
  ['/api/generator-care', '../routes/generator-care'],
  ['/api/cron/generator-care', '../routes/generator-care-cron'],
];

// Walk a router's layer stack, recursing into nested routers. Express keeps
// the original mount path string on layer.route.path for plain routes; nested
// routers expose no clean path string, so we tag them with their source order.
function collect(router, prefix, out) {
  const stack = (router && (router.stack || (router.handle && router.handle.stack))) || [];
  for (const layer of stack) {
    if (layer.route && layer.route.path !== undefined) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods || {})
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase());
      for (const p of paths) {
        for (const m of methods) {
          out.push(`${m} ${prefix}${p === '/' ? '' : p}` || '/');
        }
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // Nested router: recover its mount path from the regexp when it's a
      // simple string mount; fall back to a marker otherwise.
      let sub = '';
      if (layer.path) sub = layer.path;
      else if (layer.regexp && layer.regexp.source) {
        const m = /^\^\\?\/?([^\\?*+()[\]|]*)/.exec(layer.regexp.source);
        if (m && m[1]) sub = '/' + m[1].replace(/\\\//g, '/').replace(/\/$/, '');
        // "^\/?(?=\/|$)" (mounted at '/') yields '' — correct.
      }
      collect(layer.handle, prefix + sub, out);
    }
  }
}

const out = [];
for (const [prefix, mod] of MOUNTS) {
  const router = require(mod);
  collect(router, prefix, out);
}
out.sort();
for (const line of out) console.log(line);
console.error(`\n${out.length} routes`);
