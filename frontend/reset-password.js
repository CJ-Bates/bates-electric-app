(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';

  // Parse Supabase's recovery hash: #access_token=...&type=recovery&...
  function parseHash() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    return {
      access_token: params.get('access_token') || '',
      refresh_token: params.get('refresh_token') || '',
      type: params.get('type') || '',
      error: params.get('error_description') || params.get('error') || '',
    };
  }

  // Decode the JWT payload (no verification — server re-verifies).
  function decodeJwtPayload(jwt) {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '==='.slice((b64.length + 3) % 4);
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  function showStatus(msg, kind) {
    const el = document.getElementById('reset-status');
    if (!el) return;
    el.hidden = false;
    el.className = 'status ' + (kind || 'info');
    el.textContent = msg;
  }
  function clearStatus() {
    const el = document.getElementById('reset-status');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  function init() {
    const { access_token, type, error } = parseHash();

    const emailInput = document.getElementById('reset-email');
    const form = document.getElementById('reset-form');
    const submitBtn = document.getElementById('reset-submit');

    if (error) {
      showStatus(error, 'error');
      if (submitBtn) submitBtn.disabled = true;
      return;
    }
    if (!access_token || type !== 'recovery') {
      showStatus('This reset link is invalid or expired. Request a new one from the sign-in page.', 'error');
      if (submitBtn) submitBtn.disabled = true;
      return;
    }

    // Populate the (readonly) email field so iOS Keychain can associate the new password.
    const payload = decodeJwtPayload(access_token);
    if (payload && payload.email && emailInput) {
      emailInput.value = payload.email;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearStatus();

      const newPw = document.getElementById('reset-new').value;
      const confirmPw = document.getElementById('reset-confirm').value;

      if (newPw.length < 8) {
        showStatus('Password must be at least 8 characters.', 'error');
        return;
      }
      if (newPw !== confirmPw) {
        showStatus('Passwords do not match.', 'error');
        return;
      }

      submitBtn.disabled = true;
      const label = submitBtn.querySelector('.btn-label');
      const prev = label ? label.textContent : '';
      if (label) label.textContent = 'Updating…';

      try {
        const res = await fetch(`${API_BASE}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token, new_password: newPw }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showStatus(body.error || 'Could not update password.', 'error');
          submitBtn.disabled = false;
          if (label) label.textContent = prev;
          return;
        }
        showStatus('Password updated. Redirecting to sign in…', 'success');
        setTimeout(() => {
          window.location.replace('index.html');
        }, 1200);
      } catch (err) {
        showStatus('Network error. Please try again.', 'error');
        submitBtn.disabled = false;
        if (label) label.textContent = prev;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
