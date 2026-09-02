// ui-dialogs.js
// Shared in-app UI helpers used across every office/app page (loaded after
// shared-nav.js, before each page's own script). Replaces native window.confirm
// / window.alert / window.prompt with consistent inline dialogs + a toast.
//
// Globals exposed:
//   openConfirm({ title, message, confirmText, cancelText, danger }) -> Promise<boolean>
//   openPrompt({ title, message, fields, validate, confirmText, cancelText, danger }) -> Promise<values|null>
//   openAlert({ title, message, next, buttonText, danger }) -> Promise<void>  // must-see notice (no cancel)
//   openSuccessFlash({ title, message }) -> Promise<void>   // must-see success, no click required
//   showStatus(message, kind, { key, sticky })  // kind: 'success' | 'error' | 'info' | 'warning'
//   dismissStatus(key)          // drop one keyed toast (or every toast with no key)
//   showInlineNotice(beforeEl, message, kind)  // durable notice next to the thing it describes
//   landOn(el)                  // scroll a control into view, highlight it, focus it
//   BatesUI.escapeHtml(s)       // the one shared HTML escaper (quote-safe) —
//                               // page scripts alias it instead of re-defining it
//
// ---------------------------------------------------------------------------
// Telling a human what happened is a transport, like lib/mailer.js is for
// email — there is exactly ONE of it (this file), and outcomes are routed by
// CONSEQUENCE, not by convenience:
//
//   If the user cannot tell from looking at the screen that it worked, a
//   toast is the wrong channel. If money moved, a customer was contacted, or
//   a credential changed, it is must-see.
//
//   Must-see (tier 1) — money moved or failed to move; a customer message
//     sent, refused, or failed; a credential / invite / sign-in link created
//     or sent; an irreversible action completing.
//       failure  -> openAlert({ danger: true, next })  dismissed by a human,
//                   and `next` says what to do about it.
//       success  -> openSuccessFlash()  center-screen, announced, no click.
//   Durable inline (tier 2) — the row already reflects the change but the
//     user needs a reason, a receipt, or the NEXT STEP: showInlineNotice()
//     next to the thing (+ landOn() when the next step is a control that
//     only just appeared). Persists until the next render / navigation.
//   Toast (tier 3) — pure acknowledgement where the screen visibly changed
//     already: "Saved", "Copied", filter applied. showStatus().
//
// Keep tier 1 small. If every save needs dismissing, must-see stops meaning
// anything and people click through it blind.
// ---------------------------------------------------------------------------
//
// Styling lives in ui-dialogs.css (dialog chrome + buttons) and app.css
// (.status-stack / .status toast, .link-notice, .landed).
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- Toast stack (tier 3) --------------------------------------------------
  // Corner toasts STACK: a new message never overwrites one that hasn't been
  // read (the old single #status element + one shared timer meant "Loaded."
  // from a background refresh could erase a charge failure before anyone saw
  // it). Rules:
  //   * info / success / warning auto-dismiss after TOAST_MS, paused while
  //     the pointer is over them; 'error' stays until dismissed or the page
  //     navigates. An error is never replaced by a later info/success.
  //   * Each toast is its own live region — role="alert" (assertive) for
  //     errors, role="status" (polite) for the rest. A polite region that
  //     self-hides in 3s can be skipped entirely by assistive tech.
  //   * Toasts never take focus; the × is a real button for keyboard users.
  //   * opts.key: a later call with the same key REPLACES that toast in place
  //     (progress: "Uploading 2/10…" → "3/10…" → "Done."). Replacement is the
  //     caller's explicit choice, so it's allowed to replace an error.
  //   * opts.sticky: don't auto-dismiss (a "working…" state that a keyed
  //     follow-up call will replace).
  //   * At most TOAST_MAX on screen: overflow drops the oldest transient
  //     first; errors go only when the stack is nothing but errors.
  // CSS: .status-stack / .status in app.css.
  const TOAST_MS = 3000;
  const TOAST_MAX = 4;

  function toastStack() {
    let stack = document.getElementById('status-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'status-stack';
      stack.className = 'status-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function findToast(stack, key) {
    if (!key) return null;
    return Array.from(stack.children).find((c) => c.dataset.toastKey === key) || null;
  }

  function showStatus(msg, kind = 'info', opts = {}) {
    const stack = toastStack();
    const isError = kind === 'error';
    const el = document.createElement('div');
    el.className = `status ${kind}`;
    el.setAttribute('role', isError ? 'alert' : 'status');
    if (opts.key) el.dataset.toastKey = opts.key;
    el.innerHTML = `<span class="status-msg"></span><button type="button" class="status-close" aria-label="Dismiss">&times;</button>`;
    el.querySelector('.status-msg').textContent = msg;

    let timer = null;
    const autoDismiss = !isError && !opts.sticky;
    function dismiss() { clearTimeout(timer); el.remove(); }
    function arm() { if (autoDismiss) { clearTimeout(timer); timer = setTimeout(dismiss, TOAST_MS); } }
    el.querySelector('.status-close').addEventListener('click', dismiss);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', arm);
    el._dismiss = dismiss;

    const existing = findToast(stack, opts.key);
    // (The replaced toast's pending timer only ever removes that detached node.)
    if (existing) existing.replaceWith(el);
    else stack.appendChild(el);

    // Overflow: drop the oldest transient; only eat an error when every toast
    // on screen is one.
    while (stack.children.length > TOAST_MAX) {
      const victim = Array.from(stack.children).find((c) => !c.classList.contains('error')) || stack.firstElementChild;
      if (!victim || victim === el) break;
      victim._dismiss ? victim._dismiss() : victim.remove();
    }
    arm();
    return el;
  }

  // Remove one keyed toast (e.g. a "working…" state once a modal takes over),
  // or every toast when called with no key.
  function dismissStatus(key) {
    const stack = document.getElementById('status-stack');
    if (!stack) return;
    const targets = key ? [findToast(stack, key)].filter(Boolean) : Array.from(stack.children);
    targets.forEach((t) => (t._dismiss ? t._dismiss() : t.remove()));
  }

  // ---- Durable inline notice (tier 2) ----------------------------------------
  // A .link-notice placed right before `beforeEl` — near the thing it
  // describes — that stays until the next render or navigation. Generalises
  // the set-password page's treatment: "takes over the card instead of
  // whispering through the corner toast". One notice per anchor: a repeat call
  // replaces the previous one rather than piling up. kind: info | success |
  // warning | error.
  function showInlineNotice(beforeEl, message, kind = 'info') {
    if (!beforeEl || !beforeEl.parentNode) return null;
    const prev = beforeEl.previousElementSibling;
    if (prev && prev.dataset.inlineNotice === '1') prev.remove();
    const el = document.createElement('div');
    el.className = `link-notice ${kind}`;
    el.dataset.inlineNotice = '1';
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.textContent = message;
    beforeEl.parentNode.insertBefore(el, beforeEl);
    return el;
  }

  // Land the user on a control that just became real: scroll it into view,
  // highlight it briefly, and move focus to it so keyboard / screen-reader
  // users arrive there too. Never instruct toward a control that isn't on
  // screen when the instruction is read — call this once it exists.
  function landOn(el) {
    if (!el) return false;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); } catch (_) { el.scrollIntoView(); }
    el.classList.add('landed');
    setTimeout(() => el.classList.remove('landed'), 4000);
    setTimeout(() => { try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); } }, reduce ? 0 : 250);
    return true;
  }

  // Styled inline confirm dialog (replaces window.confirm). Resolves true/false.
  function openConfirm({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay';
      overlay.innerHTML = `
        <div class="gc-rd-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <h3 class="gc-rd-title">${escapeHtml(title)}</h3>
          ${message ? `<div class="gc-rd-sub">${escapeHtml(message)}</div>` : ''}
          <div class="gc-rd-actions">
            <button type="button" class="btn btn-secondary gc-rd-cancel">${escapeHtml(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} gc-rd-submit">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const submitEl = overlay.querySelector('.gc-rd-submit');
      const cancelEl = overlay.querySelector('.gc-rd-cancel');
      function close(result) { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(result); }
      function onKey(e) { if (e.key === 'Escape') close(false); else if (e.key === 'Enter') close(true); }
      document.addEventListener('keydown', onKey);
      cancelEl.addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      submitEl.addEventListener('click', () => close(true));
      setTimeout(() => submitEl.focus(), 30);
    });
  }

  // Must-acknowledge notice (tier 1 failures, replaces window.alert) for
  // outcomes too important for the corner toast — a refund that did NOT go
  // through, a set-password link that did NOT send. One button, dismissed by a
  // human; takes focus and is announced (role=alertdialog). `next` is the
  // "what to do now" line — a failure in this class must say what to do, not
  // just what went wrong. Focus returns to where it was on close.
  let alertSeq = 0;
  function openAlert({ title = 'Notice', message = '', next = '', buttonText = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
      const returnTo = document.activeElement;
      const descId = `gc-alert-desc-${++alertSeq}`;
      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay';
      overlay.innerHTML = `
        <div class="gc-rd-panel${danger ? ' gc-rd-danger' : ''}" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}" aria-describedby="${descId}">
          <h3 class="gc-rd-title">${escapeHtml(title)}</h3>
          <div id="${descId}">
            ${message ? `<div class="gc-rd-sub">${escapeHtml(message)}</div>` : ''}
            ${next ? `<div class="gc-rd-card gc-rd-next"><strong>What to do now:</strong> ${escapeHtml(next)}</div>` : ''}
          </div>
          <div class="gc-rd-actions">
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} gc-rd-submit">${escapeHtml(buttonText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const submitEl = overlay.querySelector('.gc-rd-submit');
      function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        if (returnTo && returnTo.isConnected && typeof returnTo.focus === 'function') { try { returnTo.focus(); } catch (_) {} }
        resolve();
      }
      function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      submitEl.addEventListener('click', close);
      setTimeout(() => submitEl.focus(), 30);
    });
  }

  // Center-screen success confirmation for CONSEQUENTIAL outcomes — money
  // moved (charge, refund), a subscription canceled, a plan/tier or Fleet
  // change, a member invited or deactivated. The corner toast is too easy to
  // miss for these (a missed outcome has caused real confusion about whether
  // a refund happened); this puts the confirmation in the middle of the
  // screen, then gets out of the way: auto-dismisses after ~2.6s, and any
  // click / Escape / Enter dismisses it sooner. No button, so it never adds a
  // required click to a workflow. Routine saves (notes, filters, checklist
  // ticks) should stay on showStatus — don't make the app modal-happy.
  function openSuccessFlash({ title = 'Done', message = '' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay gc-flash-overlay';
      overlay.innerHTML = `
        <div class="gc-rd-panel gc-flash-panel" role="status" aria-live="assertive">
          <div class="gc-flash-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
          <h3 class="gc-rd-title gc-flash-title">${escapeHtml(title)}</h3>
          ${message ? `<div class="gc-rd-sub gc-flash-sub">${escapeHtml(message)}</div>` : ''}
        </div>`;
      document.body.appendChild(overlay);
      let timer;
      function close() {
        clearTimeout(timer);
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve();
      }
      function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', close); // anywhere on screen, not just the backdrop
      timer = setTimeout(close, 2600);
    });
  }

  // Styled inline prompt dialog (replaces window.prompt, incl. multi-field flows).
  // fields: [{ name, label, type?, value?, placeholder?, options?, required?, step?, min?, inputmode?, hint? }]
  // Resolves a { name: value } object on confirm, or null on cancel.
  function openPrompt({ title, message = '', fields = [], confirmText = 'Save', cancelText = 'Cancel', validate, danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay';
      const fieldHtml = fields.map((f, i) => {
        const id = `gc-pf-${i}`;
        const nameAttr = `data-name="${escapeHtml(f.name)}"`;
        const hint = f.hint ? `<small>${escapeHtml(f.hint)}</small>` : '';
        let control;
        if (f.type === 'select') {
          const opts = (f.options || []).map((o) =>
            `<option value="${escapeHtml(String(o.value))}"${String(o.value) === String(f.value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
          control = `<select id="${id}" ${nameAttr}>${opts}</select>`;
        } else if (f.type === 'textarea') {
          control = `<textarea id="${id}" ${nameAttr} rows="3" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`;
        } else {
          const t = f.type || 'text';
          const extra = `${f.step ? ` step="${f.step}"` : ''}${f.min != null ? ` min="${f.min}"` : ''}${f.inputmode ? ` inputmode="${f.inputmode}"` : ''}`;
          control = `<input id="${id}" ${nameAttr} type="${t}" value="${escapeHtml(f.value != null ? String(f.value) : '')}" placeholder="${escapeHtml(f.placeholder || '')}"${extra}>`;
        }
        return `<label class="gc-rd-field"><span>${escapeHtml(f.label)}</span>${control}${hint}</label>`;
      }).join('');
      overlay.innerHTML = `
        <div class="gc-rd-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'Enter details')}">
          <h3 class="gc-rd-title">${escapeHtml(title || '')}</h3>
          ${message ? `<div class="gc-rd-sub">${escapeHtml(message)}</div>` : ''}
          ${fieldHtml}
          <div class="gc-rd-error" hidden></div>
          <div class="gc-rd-actions">
            <button type="button" class="btn btn-secondary gc-rd-cancel">${escapeHtml(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} gc-rd-submit">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const errEl = overlay.querySelector('.gc-rd-error');
      const submitEl = overlay.querySelector('.gc-rd-submit');
      const cancelEl = overlay.querySelector('.gc-rd-cancel');
      function close(result) { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(result); }
      function onKey(e) { if (e.key === 'Escape') close(null); }
      document.addEventListener('keydown', onKey);
      cancelEl.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      function values() {
        const out = {};
        overlay.querySelectorAll('[data-name]').forEach((el) => { out[el.dataset.name] = el.value; });
        return out;
      }
      submitEl.addEventListener('click', () => {
        const vals = values();
        for (const f of fields) {
          if (f.required && !String(vals[f.name] == null ? '' : vals[f.name]).trim()) {
            errEl.textContent = `${f.label} is required.`; errEl.hidden = false; return;
          }
        }
        if (typeof validate === 'function') {
          const msg = validate(vals);
          if (msg) { errEl.textContent = msg; errEl.hidden = false; return; }
        }
        close(vals);
      });
      setTimeout(() => { const first = overlay.querySelector('[data-name]'); if (first) first.focus(); }, 30);
    });
  }

  // QR dialog (Growth Engine WP6): renders a signup URL as a big scannable
  // code plus the same URL as copyable text, with optional extra link actions
  // (e.g. an sms: handoff). The code sits on a WHITE card in both themes —
  // scanners need dark-on-light contrast, so it deliberately ignores dark
  // mode. Requires window.qrcode (qrcode.js, the vendored offline generator)
  // — only pages that load that file may call this. Resolves when dismissed.
  // Informational only, so Enter/Escape/backdrop all just dismiss it.
  function openQrDialog({ title = 'Scan to sign up', message = '', url = '', note = '', links = [] } = {}) {
    return new Promise((resolve) => {
      let qrSvg = '';
      try {
        const qr = window.qrcode(0, 'M'); // auto version, M error correction
        qr.addData(url);
        qr.make();
        // margin 16 at cellSize 4 = the 4-module quiet zone scanners expect.
        qrSvg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
      } catch (e) {
        console.error('QR render failed', e); // dialog still offers the link
      }
      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay';
      const linkBtns = links.map((l) =>
        `<a class="btn btn-secondary gc-qr-link" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join('');
      overlay.innerHTML = `
        <div class="gc-rd-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <h3 class="gc-rd-title">${escapeHtml(title)}</h3>
          ${message ? `<div class="gc-rd-sub">${escapeHtml(message)}</div>` : ''}
          ${qrSvg
            ? `<div class="gc-qr-box">${qrSvg}</div>`
            : `<div class="gc-rd-card">Couldn&rsquo;t draw the QR code &mdash; copy the link below instead.</div>`}
          ${note ? `<p class="gc-qr-note">${escapeHtml(note)}</p>` : ''}
          <label class="gc-rd-field"><span>Signup link</span><input type="text" readonly value="${escapeHtml(url)}"></label>
          ${linkBtns ? `<div class="gc-qr-links">${linkBtns}</div>` : ''}
          <div class="gc-rd-actions">
            <button type="button" class="btn btn-secondary gc-qr-copy">Copy link</button>
            <button type="button" class="btn btn-primary gc-rd-submit">Done</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('input[readonly]');
      input.addEventListener('focus', () => input.select());
      function close() { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(); }
      function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('.gc-rd-submit').addEventListener('click', close);
      overlay.querySelector('.gc-qr-copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          showStatus('Link copied.', 'success');
        } catch (e) {
          input.focus(); // selects via the focus handler
          showStatus('Copy failed - the link is selected, copy it manually.', 'error');
        }
      });
      setTimeout(() => overlay.querySelector('.gc-rd-submit').focus(), 30);
    });
  }

  window.openConfirm = openConfirm;
  window.openPrompt = openPrompt;
  window.openAlert = openAlert;
  window.openSuccessFlash = openSuccessFlash;
  window.openQrDialog = openQrDialog;
  window.showStatus = showStatus;
  window.dismissStatus = dismissStatus;
  window.showInlineNotice = showInlineNotice;
  window.landOn = landOn;
  window.BatesUI = { escapeHtml };
})();
