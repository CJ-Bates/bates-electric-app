(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';

  // --- Tab switching ---
  const tabs = document.querySelectorAll('.auth-tab');
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      loginForm.hidden = target !== 'signin';
      signupForm.hidden = target !== 'signup';
      // Clear statuses when switching
      clearStatus('status');
      clearStatus('signup-status');
    });
  });

  // --- Helpers ---
  const showStatus = (id, msg, kind = 'info') => {
    const el = document.getElementById(id);
    el.hidden = false;
    el.className = `status ${kind}`;
    el.textContent = msg;
  };

  const clearStatus = (id) => {
    const el = document.getElementById(id);
    if (el) { el.hidden = true; el.textContent = ''; }
  };

  // If a dashboard page bounced us here on an expired/invalid session, surface
  // the reason on the sign-in form (default-active tab) and clear the one-shot flag.
  try {
    const expiredMsg = sessionStorage.getItem('bates.auth.message');
    if (expiredMsg) {
      sessionStorage.removeItem('bates.auth.message');
      showStatus('status', expiredMsg, 'error');
    }
  } catch (e) {}

  // --- Password toggle ---
  const passwordEl = document.getElementById('password');
  const toggleBtn = document.getElementById('toggle-password');

  toggleBtn.addEventListener('click', () => {
    const isPw = passwordEl.type === 'password';
    passwordEl.type = isPw ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
    passwordEl.focus();
  });

  // --- Forgot password ---
  document.getElementById('forgot-link').addEventListener('click', async (e) => {
    e.preventDefault();
    const emailEl = document.getElementById('email');
    const email = (emailEl.value || '').trim();

    if (!email) {
      showStatus('status', 'Type your email in the field above, then tap "Forgot password?" again.', 'info');
      emailEl.focus();
      return;
    }

    showStatus('status', 'Sending reset link…', 'info');
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        // Surface the server's message when it sends one (e.g. the 429
        // rate-limit body); fall back to a generic line otherwise.
        const data = await res.json().catch(() => ({}));
        const msg = typeof data.error === 'string' && data.error
          ? data.error
          : 'Could not send reset link. Try again in a moment.';
        showStatus('status', msg, 'error');
        return;
      }
      showStatus(
        'status',
        `If an account exists for ${email}, a reset link is on its way. Check your inbox (and spam folder).`,
        'success'
      );
    } catch (err) {
      showStatus('status', 'Network error. Please try again.', 'error');
    }
  });

  // --- Phone formatting ---
  const phoneInput = document.getElementById('signup-phone');
  if (phoneInput) {
    phoneInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/\D/g, '');
      if (val.length > 10) val = val.slice(0, 10);
      if (val.length >= 7) {
        e.target.value = `(${val.slice(0,3)}) ${val.slice(3,6)}-${val.slice(6)}`;
      } else if (val.length >= 4) {
        e.target.value = `(${val.slice(0,3)}) ${val.slice(3)}`;
      } else if (val.length > 0) {
        e.target.value = `(${val}`;
      }
    });
  }

  // --- Sign In ---
  const submitBtn = document.getElementById('submit-btn');
  const btnLabel = submitBtn.querySelector('.btn-label');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearStatus('status');

    const email = document.getElementById('email').value.trim();
    const password = passwordEl.value;

    if (!email || !password) {
      showStatus('status', 'Enter your email and password to sign in.', 'error');
      return;
    }

    submitBtn.disabled = true;
    btnLabel.textContent = 'Signing in\u2026';

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Only render string messages — a non-JSON or oddly-shaped error body
        // must never surface as "[object Object]".
        const msg = [data.error, data.message].find((m) => typeof m === 'string' && m);
        throw new Error(msg || 'Sign in failed. Check your credentials.');
      }

      const data = await res.json();
      if (data.token) {
        // "Keep me signed in" → localStorage (survives browser restarts, refreshed
        // for ~30 days); unchecked → sessionStorage (ends when the browser closes,
        // refreshed through the workday). Store the refresh token alongside the
        // access token so the session can be silently renewed (see shared-nav.js).
        const remember = document.getElementById('remember').checked;
        const store = remember ? localStorage : sessionStorage;
        const other = remember ? sessionStorage : localStorage;
        other.removeItem('bates.auth.token');
        other.removeItem('bates.auth.refresh');
        store.setItem('bates.auth.token', data.token);
        if (data.refresh_token) store.setItem('bates.auth.refresh', data.refresh_token);
      }
      // Cache the profile the login response already carries so role-guard.js
      // can route the FIRST page pre-paint: otherwise sign-in is the one
      // entry point guaranteed a cache miss (blank role-pending wait + a
      // /home bounce, worst for a tech on weak field signal). Always
      // localStorage, even when "Keep me signed in" put the tokens in
      // sessionStorage: every reader (role-guard, shared-nav, settings) reads
      // localStorage only, and it's a routing convenience, not a credential;
      // sign-out and session-expiry both clear it. Best-effort: a failed
      // write (private mode, storage full) must never block sign-in; the
      // async /me checks re-cache and stay authoritative.
      let role = null;
      try {
        if (data.profile && typeof data.profile.role === 'string') {
          role = data.profile.role;
          localStorage.setItem('bates.profile', JSON.stringify(data.profile));
        }
      } catch (err) { /* guards fall back to the /me check */ }
      showStatus('status', 'Signed in. Loading your hub\u2026', 'success');
      // Route on the known role: techs go straight to My Day instead of
      // bouncing through /home. Missing/odd profile keeps today's behavior.
      window.location.replace(role === 'tech' ? '/tech' : '/home');
    } catch (err) {
      showStatus('status', err.message || 'Unable to sign in right now. Try again.', 'error');
    } finally {
      submitBtn.disabled = false;
      btnLabel.textContent = 'Sign In';
    }
  });

  // --- Sign Up ---
  const signupBtn = document.getElementById('signup-btn');
  const signupBtnLabel = signupBtn.querySelector('.btn-label');

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearStatus('signup-status');

    const full_name = document.getElementById('signup-name').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirm = document.getElementById('signup-confirm').value;

    if (!full_name || !phone || !email || !password) {
      showStatus('signup-status', 'All fields are required.', 'error');
      return;
    }

    if (password.length < 8) {
      showStatus('signup-status', 'Password must be at least 8 characters.', 'error');
      return;
    }

    if (password !== confirm) {
      showStatus('signup-status', 'Passwords do not match.', 'error');
      return;
    }

    signupBtn.disabled = true;
    signupBtnLabel.textContent = 'Creating account\u2026';

    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name, phone }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Signup failed. Please try again.');
      }

      showStatus('signup-status', 'Account created! You can now sign in.', 'success');
      // Switch to sign in tab after brief delay
      setTimeout(() => {
        document.getElementById('tab-signin').click();
        document.getElementById('email').value = email;
        showStatus('status', 'Account created! Sign in with your new credentials.', 'success');
      }, 1500);
    } catch (err) {
      showStatus('signup-status', err.message || 'Unable to create account. Try again.', 'error');
    } finally {
      signupBtn.disabled = false;
      signupBtnLabel.textContent = 'Create Account';
    }
  });

  // --- Service Worker ---
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !isLocal) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  } else if ('serviceWorker' in navigator && isLocal) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
  }
})();
