const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'Supabase env vars missing. Check SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in backend/.env'
  );
}

// Anon client: used for sign-up / sign-in on behalf of the end user.
const supabaseAnon = createClient(url, anonKey, {
  auth: { persistSession: false, flowType: 'implicit' },
});

// Admin client: bypasses RLS. Use only for trusted server-side operations
// (e.g. looking up a profile after verifying a token). Never return data
// from this client without enforcing permissions yourself.
const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

// Per-request client bound to an end user's access token. Reads/writes
// through this client are subject to RLS, so policies do the permission work.
function supabaseForUser(accessToken) {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = { supabaseAnon, supabaseAdmin, supabaseForUser };
