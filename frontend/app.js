(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';

  const form = document.getElementById('login-form');
  const emailEl = document.getElementById('email');
  const passwordEl = document.getElementById('password');
  const toggleBtn = document.getElementById('toggle-password');
  const submitBtn = document.getElementById('submit-btn');
  const btnLabel = submitBtn.querySelector('.btn-label');
  const statusEl = document.getElementById('status');
  const forgotLink = document.getElementById('forgot-link');

  const showStatus = (msg, kind = 'info') => {
    statusEl.hidden = false;
    statusEl.className = `status ${kind}`;
    statusEl.textContent = msg;
  };

  const clearStatus = () => {
    statusEl.hidden = true;
    statusEl.textContent = '';
  };

  toggleBtn.addEventListener('click', () => {
    const isPw = passwordEl.type === 'password';
    passwordEl.type = isPw ? 'text' : 'password';
    toggleBtn.textContent = isPw ? 'Hide' : 'Show';
    toggleBtn.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
    passwordEl.focus();
  });

  forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    showStatus('Contact your supervisor to reset your password.', 'info');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearStatus();

    const email = emailEl.value.trim();
    const password = passwordEl.value;

    if (!email || !password) {
      showStatus('Enter your email and password to sign in.', 'error');
      return;
    }

    submitBtn.disabled = true;
    btnLabel.textContent = 'Signing in…';

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Sign in failed. Check your credentials.');
      }

      const data = await res.json();
      if (data.token) {
        const remember = document.getElementById('remember').checked;
        const store = remember ? localStorage : sessionStorage;
        // Clear whichever store we're NOT using so we never have two stale tokens.
        (remember ? sessionStorage : localStorage).removeItem('bates.auth.token');
        store.setItem('bates.auth.token', data.token);
      }
      showStatus('Signed in. Loading your hub…', 'info');
      window.location.replace('home.html');
    } catch (err) {
      showStatus(err.message || 'Unable to sign in right now. Try again.', 'error');
    } finally {
      submitBtn.disabled = false;
      btnLabel.textContent = 'Sign In';
    }
  });

  // Skip the service worker on localhost so code changes show up immediately.
  // In production it'll register normally and provide offline support.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !isLocal) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  } else if ('serviceWorker' in navigator && isLocal) {
    // Unregister any leftover dev service workers from earlier sessions.
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
  }
})();
