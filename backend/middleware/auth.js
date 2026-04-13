const { supabaseAdmin } = require('../lib/supabase');

// Reads the Authorization: Bearer <token> header, verifies the token with
// Supabase Auth, loads the matching profile row, and attaches both to req.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || !profile) {
    return res.status(403).json({ error: 'No profile found for this user' });
  }

  req.user = userData.user;
  req.profile = profile;
  req.token = token;
  next();
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.profile || !allowed.includes(req.profile.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
