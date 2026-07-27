// backend/routes/members.js
// Member management API for the Members page — ADMIN ONLY (profiles.is_admin).
// Office staff: invite (invite-only signup — self-signup for the office domain
// is disabled), permission toggles, deactivate/reactivate, promote/demote
// admin. Customers: read-only portal-account list + revoke access + resend
// sign-in instructions. Field-tech CRUD stays on /api/generator-care/techs
// (gated by the tech_manage flag) so a non-admin with tech_manage can still
// manage techs; the endpoints here are the admin-only surface.
//
// Mounted by server.js at /api/members.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  requireAdmin,
  effectivePermissions,
  ALL_FLAGS,
} = require('../middleware/permissions');
const { sendEmail, sendSetPasswordEmail, DASHBOARD_URL } = require('../lib/emails');
const { makeGeneralLimiter, makeSensitiveLimiter } = require('../middleware/limiters');

const router = express.Router();

router.use(requireAuth, requireRole('office'), requireAdmin);

// Generous abuse backstop over the whole admin API; the tighter limiter below
// guards the invite/resend endpoints that send email.
router.use(makeGeneralLimiter());
const sensitiveLimiter = makeSensitiveLimiter();

function isOfficeEmail(email) {
  return !!email && /@bates-electric\.com$/i.test(String(email).trim());
}

// Escape LIKE metacharacters (\ % _) so an email is matched literally by ILIKE
// (case-insensitive but no wildcards). generator_customers.email is stored with
// its original casing, so we keep ILIKE rather than a case-sensitive .eq.
const likeEscape = (s) => String(s == null ? '' : s).replace(/[\\%_]/g, '\\$&');

// Map of auth.users id -> last_sign_in_at. The user count is tiny (staff +
// techs + a handful of portal customers), so one page is plenty.
async function lastSignInMap() {
  const map = {};
  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    for (const u of (data && data.users) || []) map[u.id] = u.last_sign_in_at || null;
  } catch (err) {
    // Last sign-in is display-only — don't fail the whole listing over it.
    console.error('[members] listUsers failed:', err && err.message);
  }
  return map;
}

// ============================================================================
// Staff + techs
// ============================================================================

// GET /api/members — office staff + techs with role, active, admin flag,
// effective permissions, and last sign-in.
router.get('/', async (req, res) => {
  try {
    const [{ data: profiles, error: profErr }, signIns] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, role, active, is_admin, created_at')
        .in('role', ['office', 'tech'])
        .order('role', { ascending: true })
        .order('full_name', { ascending: true }),
      lastSignInMap(),
    ]);
    if (profErr) throw profErr;

    const ids = (profiles || []).map((p) => p.id);
    const { data: permRows, error: permErr } = await supabaseAdmin
      .from('member_permissions')
      .select('*')
      .in('profile_id', ids);
    if (permErr) throw permErr;
    const rowByProfile = {};
    for (const r of permRows || []) rowByProfile[r.profile_id] = r;

    const members = (profiles || []).map((p) => ({
      ...p,
      last_sign_in_at: signIns[p.id] || null,
      permissions: effectivePermissions(p, rowByProfile[p.id] || null),
    }));
    res.json({ members });
  } catch (err) {
    console.error('[members] list error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/members/invite  { name, email }
// Office accounts are invite-only: record the invite (which is what the signup
// trigger accepts), create the auth user (the trigger inserts the office
// profile + default permissions), and email a set-password link — the same
// flow techs get. The office never sets the password.
router.post('/invite', sensitiveLimiter, async (req, res) => {
  try {
    const name = ((req.body && req.body.name) || '').trim();
    const email = ((req.body && req.body.email) || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!isOfficeEmail(email)) {
      return res.status(400).json({ error: 'Office email must be an @bates-electric.com address.' });
    }

    // The invite row is the signup authorization — written only here, with the
    // service role, so it can't be forged with the public anon key.
    const { error: inviteErr } = await supabaseAdmin
      .from('office_invites')
      .upsert({ email, invited_by: req.profile.id }, { onConflict: 'email' });
    if (inviteErr) throw inviteErr;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (createErr) {
      const msg = /already.*registered|already exists|duplicate/i.test(createErr.message || '')
        ? 'A user with that email already exists.'
        : createErr.message;
      return res.status(400).json({ error: msg });
    }

    // The signup trigger (sql/015) creates the default permissions row; this
    // upsert is belt-and-suspenders so the member never lands without one.
    await supabaseAdmin
      .from('member_permissions')
      .upsert({ profile_id: created.user.id, updated_by: req.profile.id }, { onConflict: 'profile_id', ignoreDuplicates: true });

    try {
      await sendSetPasswordEmail({ email, name, mode: 'create' });
    } catch (mailErr) {
      console.error('[members] office invite email failed:', mailErr.message);
      return res.json({
        ok: true,
        member: { id: created.user.id, email, full_name: name, active: true },
        warning: 'Account created, but the set-password email failed to send. Use "Resend link".',
      });
    }

    res.json({ ok: true, member: { id: created.user.id, email, full_name: name, active: true } });
  } catch (err) {
    console.error('[members] invite error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/members/:id/resend-invite — resend the set-password link (office).
router.post('/:id/resend-invite', sensitiveLimiter, async (req, res) => {
  try {
    const { data: member, error } = await supabaseAdmin
      .from('profiles')
      .select('email, full_name, role')
      .eq('id', req.params.id)
      .single();
    if (error || !member) return res.status(404).json({ error: 'member not found' });
    if (member.role !== 'office') return res.status(400).json({ error: 'not an office account' });
    try {
      await sendSetPasswordEmail({ email: member.email, name: member.full_name, mode: 'create' });
    } catch (mailErr) {
      console.error('[members] resend invite email failed:', mailErr.message);
      return res.status(502).json({ error: 'Could not send the email. Try again shortly.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[members] resend invite error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/members/:id/permissions  { accounting?, refunds?, ... }
// Upserts the member's row; only known flags, booleans only. Works for office
// staff (office flags) and techs (tech_reschedule).
router.patch('/:id/permissions', async (req, res) => {
  try {
    const { data: member, error } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_admin, active, email, full_name')
      .eq('id', req.params.id)
      .single();
    if (error || !member) return res.status(404).json({ error: 'member not found' });
    if (member.role !== 'office' && member.role !== 'tech') {
      return res.status(400).json({ error: 'permissions apply to office and tech accounts only' });
    }

    const updates = {};
    for (const flag of ALL_FLAGS) {
      if (typeof (req.body || {})[flag] === 'boolean') updates[flag] = req.body[flag];
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no valid permission flags provided' });
    }

    const { data: row, error: upErr } = await supabaseAdmin
      .from('member_permissions')
      .upsert(
        {
          profile_id: member.id,
          ...updates,
          updated_at: new Date().toISOString(),
          updated_by: req.profile.id,
        },
        { onConflict: 'profile_id' }
      )
      .select('*')
      .single();
    if (upErr) throw upErr;

    res.json({ ok: true, permissions: effectivePermissions(member, row) });
  } catch (err) {
    console.error('[members] permissions patch error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/members/:id  { active }  — deactivate / reactivate office staff.
// (Techs keep their existing endpoint under /api/generator-care/techs.)
// Deactivation blocks sign-in at the door (login) and every API call
// (requireAuth rejects active=false).
router.patch('/:id', async (req, res) => {
  try {
    const active = req.body && req.body.active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    if (req.params.id === req.profile.id) {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }

    const { data: member, error } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_admin')
      .eq('id', req.params.id)
      .single();
    if (error || !member) return res.status(404).json({ error: 'member not found' });
    if (member.role !== 'office') return res.status(400).json({ error: 'not an office account' });
    if (member.is_admin && !active) {
      return res.status(400).json({ error: 'Remove admin from this member before deactivating them.' });
    }

    const { data: updated, error: upErr } = await supabaseAdmin
      .from('profiles')
      .update({ active })
      .eq('id', member.id)
      .select('id, email, full_name, active, is_admin')
      .single();
    if (upErr) throw upErr;
    res.json({ ok: true, member: updated });
  } catch (err) {
    console.error('[members] active patch error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/members/:id/admin  { is_admin }  — promote / demote.
// The last active admin can never be demoted (that would lock everyone out of
// member management; since the caller is an admin, that case is always
// self-demotion).
router.post('/:id/admin', async (req, res) => {
  try {
    const isAdmin = req.body && req.body.is_admin;
    if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'is_admin (boolean) required' });

    const { data: member, error } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_admin, active')
      .eq('id', req.params.id)
      .single();
    if (error || !member) return res.status(404).json({ error: 'member not found' });
    if (member.role !== 'office') return res.status(400).json({ error: 'only office accounts can be admins' });

    if (!isAdmin && member.is_admin) {
      const { count, error: cntErr } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('is_admin', true)
        .neq('active', false)
        .neq('id', member.id);
      if (cntErr) throw cntErr;
      if (!count) {
        return res.status(400).json({ error: "You're the last administrator — promote someone else first." });
      }
    }
    if (isAdmin && member.active === false) {
      return res.status(400).json({ error: 'Reactivate this member before making them an admin.' });
    }

    const { data: updated, error: upErr } = await supabaseAdmin
      .from('profiles')
      .update({ is_admin: isAdmin })
      .eq('id', member.id)
      .select('id, email, full_name, active, is_admin')
      .single();
    if (upErr) throw upErr;
    res.json({ ok: true, member: updated });
  } catch (err) {
    console.error('[members] admin toggle error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// Customers (portal accounts)
// ============================================================================

// GET /api/members/customers — customer-role profiles with last sign-in.
router.get('/customers', async (req, res) => {
  try {
    const [{ data: profiles, error }, signIns] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, active, created_at')
        .eq('role', 'customer')
        .order('created_at', { ascending: false }),
      lastSignInMap(),
    ]);
    if (error) throw error;
    res.json({
      customers: (profiles || []).map((p) => ({ ...p, last_sign_in_at: signIns[p.id] || null })),
    });
  } catch (err) {
    console.error('[members] customers list error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/members/customers/:id  { active }  — revoke / restore portal
// access. Their Generator Care subscription is untouched; this only blocks the
// my.bates-electric.com portal sign-in.
router.patch('/customers/:id', async (req, res) => {
  try {
    const active = req.body && req.body.active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    const { data: updated, error } = await supabaseAdmin
      .from('profiles')
      .update({ active })
      .eq('id', req.params.id)
      .eq('role', 'customer')
      .select('id, email, full_name, active')
      .maybeSingle();
    if (error) throw error;
    if (!updated) return res.status(404).json({ error: 'customer account not found' });
    res.json({ ok: true, customer: updated });
  } catch (err) {
    console.error('[members] customer active patch error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/members/customers/:id/resend-signin — email the customer their
// portal sign-in instructions via Brevo. No server-side magic-link generation:
// the portal itself emails the link when they enter their address.
router.post('/customers/:id/resend-signin', sensitiveLimiter, async (req, res) => {
  try {
    const { data: customer, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, active, role')
      .eq('id', req.params.id)
      .eq('role', 'customer')
      .maybeSingle();
    if (error) throw error;
    if (!customer) return res.status(404).json({ error: 'customer account not found' });
    if (customer.active === false) {
      return res.status(400).json({ error: 'Portal access is revoked for this customer. Restore it first.' });
    }

    // FL customers get the S.E. Bates Electric sender name; the install state
    // lives on their Generator Care record, matched by email.
    let companyState = null;
    let displayName = customer.full_name || '';
    try {
      const { data: gc } = await supabaseAdmin
        .from('generator_customers')
        .select('name, install_state')
        .ilike('email', likeEscape(customer.email))
        .maybeSingle();
      if (gc) {
        companyState = gc.install_state || null;
        displayName = gc.name || displayName;
      }
    } catch (e) { /* branding lookup is best-effort */ }

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    const firstName = (displayName || '').split(' ')[0] || 'there';
    // Canonical dashboard URL lives in lib/emails.js (currently app./my until
    // the my. TLS cert is verified live — see the constant's comment).
    const portalUrl = DASHBOARD_URL;
    const portalDisplay = portalUrl.replace(/^https?:\/\//, '');
    const html = `
      <p>Hi ${esc(firstName)},</p>
      <p>Here&rsquo;s how to sign in to your Generator Care customer portal:</p>
      <ol>
        <li>Go to <a href="${portalUrl}">${esc(portalDisplay)}</a></li>
        <li>Enter this email address: <strong>${esc(customer.email)}</strong></li>
        <li>We&rsquo;ll email you a secure sign-in link &mdash; click it and you&rsquo;re in. No password needed.</li>
      </ol>
      <p>In the portal you can see your plan, upcoming service visits, and billing history.</p>
      <p>Questions? Reply to generators@bates-electric.com or call (636) 464-3939.</p>`;
    const text = `Hi ${firstName},\n\nSign in to your Generator Care customer portal:\n\n1. Go to ${portalUrl}\n2. Enter this email address: ${customer.email}\n3. We'll email you a secure sign-in link - click it and you're in. No password needed.\n\nQuestions? Email generators@bates-electric.com or call (636) 464-3939.`;

    const result = await sendEmail({
      to: customer.email,
      subject: 'How to sign in to your Generator Care portal',
      html,
      text,
      logTag: '[members-resend-signin]',
      companyState,
    });
    if (!result.sent) return res.status(502).json({ error: 'Could not send the email. Try again shortly.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[members] resend signin error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
