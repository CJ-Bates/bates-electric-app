// Per-member permission checks, layered on top of requireAuth (which attaches
// req.profile). Flags live in public.member_permissions — one row per member,
// service-role only (see sql/014). Admins (profiles.is_admin) pass every check.
//
// Flags are consulted per role: the office flags only matter for role='office',
// tech_reschedule only for role='tech'. A member with no row gets their ROLE
// DEFAULTS (office: all office flags true; tech: tech_reschedule true) — the
// same values a fresh row is created with, so behavior matches whether the row
// exists yet or not. Office rows are backfilled by 014 and created by the
// invite flow; techs get no row until a flag is first toggled off.
//
// This middleware is the PRIMARY enforcement (office routes run on the service
// role, which bypasses RLS). The member_has_permission() SQL helper mirrors
// these rules for the data layer.

const { supabaseAdmin } = require('../lib/supabase');

const OFFICE_FLAGS = ['accounting', 'refunds', 'billing_actions', 'customer_edit', 'tech_manage'];
const TECH_FLAGS = ['tech_reschedule'];
const ALL_FLAGS = OFFICE_FLAGS.concat(TECH_FLAGS);

// The member_permissions row for a profile, or null when none exists.
async function getPermissionRow(profileId) {
  const { data, error } = await supabaseAdmin
    .from('member_permissions')
    .select('*')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Resolve every flag for a profile: admin passes all; otherwise the row value,
// falling back to the role defaults when there is no row.
function effectivePermissions(profile, row) {
  const perms = {};
  for (const flag of ALL_FLAGS) {
    if (profile.is_admin === true) {
      perms[flag] = true;
    } else if (row && typeof row[flag] === 'boolean') {
      perms[flag] = row[flag];
    } else if (OFFICE_FLAGS.includes(flag)) {
      perms[flag] = profile.role === 'office';
    } else {
      perms[flag] = profile.role === 'tech';
    }
  }
  return perms;
}

// requirePermission('refunds') — mount AFTER requireAuth (+ requireRole).
// Loads the member's row once per request (cached on req).
function requirePermission(flag) {
  return async (req, res, next) => {
    try {
      if (!req.profile) return res.status(403).json({ error: 'Forbidden' });
      if (req.profile.is_admin === true) return next();
      if (req._memberPermRow === undefined) {
        req._memberPermRow = await getPermissionRow(req.profile.id);
      }
      const perms = effectivePermissions(req.profile, req._memberPermRow);
      if (perms[flag] !== true) {
        return res.status(403).json({
          error: "You don't have permission for this action. Ask an administrator.",
        });
      }
      next();
    } catch (err) {
      console.error('[permissions] check failed:', err && err.message);
      res.status(500).json({ error: 'Server error' });
    }
  };
}

// Admin-only endpoints (member management). Mount AFTER requireAuth.
function requireAdmin(req, res, next) {
  if (!req.profile || req.profile.is_admin !== true) {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

module.exports = {
  OFFICE_FLAGS,
  TECH_FLAGS,
  ALL_FLAGS,
  getPermissionRow,
  effectivePermissions,
  requirePermission,
  requireAdmin,
};
