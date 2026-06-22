// backend/lib/branding.js
// Single source of truth for the Florida DBA naming rule.
//
// Per a trademark settlement, the company must operate as "S.E. Bates Electric"
// in Florida (another company owns "Bates Electric" there). Everywhere else it
// stays "Bates Electric." This is conditional on the customer's install-address
// STATE only — the email domain, phone, and mailing address never change.
//
// Used by the email templates (lib/emails.js) and the dashboard/API; the
// frontend mirrors this exact logic.

// True when the install-address state is Florida. Liberal on purpose: trim,
// case-insensitive, accepts both "FL" and "Florida".
function isFlorida(state) {
  if (!state) return false;
  const s = String(state).trim().toLowerCase();
  return s === 'fl' || s === 'florida';
}

// The displayed company name for a given install-address state.
function companyName(state) {
  return isFlorida(state) ? 'S.E. Bates Electric' : 'Bates Electric';
}

module.exports = { isFlorida, companyName };
