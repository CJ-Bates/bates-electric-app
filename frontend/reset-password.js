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

  // Inline (in-card) messages. The corner toast (.status) is deliberately NOT
  // used on this page: a first-time user staring at the form never sees it,
  // which is exactly how a dead invite link got misread as "the screen reset".
  function showMsg(el, msg, kind) {
    if (!el) return;
    el.hidden = false;
    el.className = 'inline-msg ' + (kind || 'info');
    el.textContent = msg;
  }
  function hideMsg(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  function setBtnLabel(btn, text) {
    const label = btn && btn.querySelector('.btn-label');
    if (label) label.textContent = text;
  }

  // Copy for the takeover state. `expired` is the common case (Supabase
  // recovery links are single-use and short-lived); the others are rarer
  // but must not be mislabelled as "expired" — a network blip is not a dead link.
  const DEAD_COPY = {
    expired: {
      tagline: 'This link can’t be used',
      title: 'This link has expired',
      body: 'Set-password links only work once and for a short time after they’re sent. '
        + 'This one has expired or was already used, so it can’t be used to set a password.',
      resend: true,
    },
    missing: {
      tagline: 'This link can’t be used',
      title: 'This isn’t a complete link',
      body: 'This page opened without a valid set-password link. Open the link from your email '
        + 'directly (tap the button in the email rather than copying part of it), or request a fresh one below.',
      resend: true,
    },
    busy: {
      tagline: 'Please wait a moment',
      title: 'Too many attempts',
      body: 'This link has been checked too many times in a short period. Wait a few minutes, then try again. '
        + 'The link itself may still be fine.',
      resend: false,
    },
    network: {
      tagline: 'Couldn’t reach the server',
      title: 'Couldn’t check your link',
      body: 'We couldn’t reach the server to check this link. Make sure you’re online and try again. '
        + 'The link itself may still be fine.',
      resend: false,
    },
  };

  function init() {
    const tagline = document.getElementById('reset-tagline');
    const emailInput = document.getElementById('reset-email');
    const newInput = document.getElementById('reset-new');
    const confirmInput = document.getElementById('reset-confirm');
    const form = document.getElementById('reset-form');
    const formMsg = document.getElementById('reset-form-msg');
    const submitBtn = document.getElementById('reset-submit');

    const checkingEl = document.getElementById('link-checking');
    const deadEl = document.getElementById('link-dead');
    const deadTitle = document.getElementById('link-dead-title');
    const deadBody = document.getElementById('link-dead-body');
    const retryBtn = document.getElementById('link-retry');
    const resendForm = document.getElementById('resend-form');
    const resendEmail = document.getElementById('resend-email');
    const resendBtn = document.getElementById('resend-submit');
    const resendMsg = document.getElementById('resend-msg');
    const successEl = document.getElementById('link-success');

    // Recovery access token, filled by whichever link flavor brought us here:
    // the ?token_hash=... query (invite + reset emails) verified via the
    // backend, or the legacy #access_token=... hash.
    let accessToken = '';
    // 'checking' | 'ready' | 'dead' | 'submitting' | 'success'
    let state = 'checking';
    // Remembered so a "Try again" after a network failure can re-run the check.
    let pendingTokenHash = '';

    // The password fields + submit are disabled in the markup and only enabled
    // here, once a token is actually in hand. Every other state re-disables
    // them, so a password can never be typed into a form that cannot submit.
    function setFormEnabled(on) {
      newInput.disabled = !on;
      confirmInput.disabled = !on;
      submitBtn.disabled = !on;
    }

    function showPanel(which) {
      checkingEl.hidden = which !== 'checking';
      form.hidden = !(which === 'checking' || which === 'form');
      deadEl.hidden = which !== 'dead';
      successEl.hidden = which !== 'success';
    }

    function showChecking() {
      state = 'checking';
      accessToken = '';
      setFormEnabled(false);
      hideMsg(formMsg);
      tagline.textContent = 'Just a moment';
      showPanel('checking');
    }

    function showReady(email) {
      state = 'ready';
      hideMsg(formMsg);
      // Populate the (readonly) email field so iOS Keychain can associate
      // the new password.
      if (email && emailInput) emailInput.value = email;
      tagline.textContent = 'Choose a password to continue';
      showPanel('form');
      setFormEnabled(true);
      newInput.focus();
    }

    // Take over the card. No toast, no live form — the only things on screen
    // are the explanation and a way out.
    function showDead(kind, emailHint) {
      state = 'dead';
      accessToken = '';
      setFormEnabled(false);
      hideMsg(formMsg);
      const copy = DEAD_COPY[kind] || DEAD_COPY.expired;
      tagline.textContent = copy.tagline;
      deadTitle.textContent = copy.title;
      deadBody.textContent = copy.body;
      deadEl.dataset.kind = kind;
      retryBtn.hidden = copy.resend;
      resendForm.hidden = !copy.resend;
      // "Ask the office to resend" only makes sense when the link is dead,
      // not when we simply couldn't reach the server.
      const foot = deadEl.querySelector('.link-panel-foot');
      if (foot) foot.hidden = !copy.resend;
      if (emailHint && resendEmail && !resendEmail.value) resendEmail.value = emailHint;
      showPanel('dead');
      // Focus the heading so screen readers announce the takeover and
      // keyboard users land at the top of the new content.
      deadTitle.setAttribute('tabindex', '-1');
      deadTitle.focus({ preventScroll: false });
    }

    function showSuccess() {
      state = 'success';
      accessToken = '';
      setFormEnabled(false);
      hideMsg(formMsg);
      tagline.textContent = 'You’re all set';
      showPanel('success');
    }

    // ---- Set password -----------------------------------------------------
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideMsg(formMsg);

      // The controls are disabled in every state but 'ready', so a submit
      // arriving mid-check / after a dead link / after success is a stray
      // (e.g. programmatic requestSubmit) — ignore it rather than mislabel it.
      if (state !== 'ready') return;
      // Belt and braces: 'ready' without a token should be impossible; if it
      // happens, take over the page rather than whispering in the corner.
      if (!accessToken) {
        showDead('expired');
        return;
      }

      const newPw = newInput.value;
      const confirmPw = confirmInput.value;

      if (newPw.length < 8) {
        showMsg(formMsg, 'Password must be at least 8 characters.', 'error');
        newInput.focus();
        return;
      }
      if (newPw !== confirmPw) {
        showMsg(formMsg, 'Passwords do not match.', 'error');
        confirmInput.focus();
        return;
      }

      state = 'submitting';
      setFormEnabled(false);
      setBtnLabel(submitBtn, 'Saving…');

      const restoreForm = () => {
        state = 'ready';
        setFormEnabled(true);
        setBtnLabel(submitBtn, 'Set Password');
      };

      try {
        const res = await fetch(`${API_BASE}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken, new_password: newPw }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 401 = the recovery session itself is no longer valid (the user sat
          // on the page long enough for it to lapse). That's a dead link, not
          // a form error, so it gets the takeover treatment too.
          if (res.status === 401) {
            showDead('expired');
            return;
          }
          showMsg(formMsg, body.error || 'Could not set password.', 'error');
          restoreForm();
          return;
        }

        // Success must be unmistakable: an in-card success state that stays
        // put, plus the shared success flash (if the helper loaded) which
        // holds for ~2.6s or until the user taps. Only then do we redirect.
        showSuccess();
        const hold = (typeof window.openSuccessFlash === 'function')
          ? window.openSuccessFlash({ title: 'Password set', message: 'Taking you to sign in…' })
          : new Promise((resolve) => setTimeout(resolve, 3000));
        await hold;
        window.location.replace('/');
      } catch (err) {
        showMsg(formMsg, 'Network error. Please try again.', 'error');
        restoreForm();
      }
    });

    // ---- Send me a new link -------------------------------------------------
    // Posts to the existing /auth/forgot-password: it always answers {ok:true}
    // whether or not the address exists (non-enumeration) and is strictly
    // rate-limited server-side. The button stays disabled after one send so
    // a nervous tap-tap-tap doesn't burn through the limiter.
    resendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideMsg(resendMsg);
      const email = (resendEmail.value || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMsg(resendMsg, 'Enter the email address your invite was sent to.', 'error');
        resendEmail.focus();
        return;
      }

      resendBtn.disabled = true;
      resendEmail.disabled = true;
      setBtnLabel(resendBtn, 'Sending…');
      const restore = () => {
        resendBtn.disabled = false;
        resendEmail.disabled = false;
        setBtnLabel(resendBtn, 'Send me a new link');
      };

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
          const msg = (typeof data.error === 'string' && data.error)
            ? data.error
            : 'Could not send a new link. Try again in a moment.';
          showMsg(resendMsg, msg, 'error');
          restore();
          return;
        }
        setBtnLabel(resendBtn, 'Sent');
        showMsg(
          resendMsg,
          `If an account exists for ${email}, a new link is on its way. Check your inbox (and spam folder) `
            + 'and open it right away — it expires.',
          'success'
        );
      } catch (err) {
        showMsg(resendMsg, 'Network error. Please try again.', 'error');
        restore();
      }
    });

    // ---- Verify the link ----------------------------------------------------
    // Modern links: ?token_hash=...&type=recovery — exchange the token hash
    // for a session via the backend before enabling the form.
    function verifyTokenHash(tokenHash) {
      showChecking();
      return fetch(`${API_BASE}/auth/verify-recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_hash: tokenHash }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (res.status === 429) {
            showDead('busy');
            return;
          }
          if (!res.ok || !body.access_token) {
            showDead('expired');
            return;
          }
          accessToken = body.access_token;
          showReady(body.email || '');
        })
        .catch(() => {
          showDead('network');
        });
    }

    retryBtn.addEventListener('click', () => {
      if (pendingTokenHash) verifyTokenHash(pendingTokenHash);
    });

    const query = new URLSearchParams(window.location.search);
    const tokenHash = query.get('token_hash') || '';
    if (tokenHash && query.get('type') === 'recovery') {
      pendingTokenHash = tokenHash;
      verifyTokenHash(tokenHash);
      return;
    }

    // Legacy links: token delivered in the URL hash (#access_token=...).
    const { access_token, type, error } = parseHash();

    if (error) {
      // Supabase's own redirect puts e.g. "Email link is invalid or has
      // expired" here — that is the expired case, in our words.
      showDead('expired');
      return;
    }
    if (!access_token || type !== 'recovery') {
      showDead('missing');
      return;
    }

    const payload = decodeJwtPayload(access_token);
    const email = (payload && payload.email) || '';
    // The hash-style token is a JWT with an exp claim; if it has already
    // lapsed the server will reject it anyway, so say so up front instead of
    // letting the user type a password first.
    if (payload && typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
      showDead('expired', email);
      return;
    }

    accessToken = access_token;
    showReady(email);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
