// ui-dialogs.js
// Shared in-app UI helpers used across every office/app page (loaded after
// shared-nav.js, before each page's own script). Replaces native window.confirm
// / window.alert / window.prompt with consistent inline dialogs + a toast.
//
// Globals exposed:
//   openConfirm({ title, message, confirmText, cancelText, danger }) -> Promise<boolean>
//   openPrompt({ title, message, fields, validate, confirmText, cancelText, danger }) -> Promise<values|null>
//   showStatus(message, kind)   // kind: 'success' | 'error' | 'info' | 'warning'
//   BatesUI.escapeHtml(s)       // the one shared HTML escaper (quote-safe) —
//                               // page scripts alias it instead of re-defining it
//
// Styling lives in ui-dialogs.css (dialog chrome + buttons) and app.css (.status toast).
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Toast. Finds the page's #status element, or creates one (so pages without it
  // — e.g. settings, site-visit — still get toasts). .status CSS is in app.css.
  function showStatus(msg, kind = 'info') {
    let el = document.getElementById('status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'status';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.hidden = false;
    el.className = `status ${kind}`;
    el.textContent = msg;
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => { el.hidden = true; }, 3000);
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
  window.openQrDialog = openQrDialog;
  window.showStatus = showStatus;
  window.BatesUI = { escapeHtml };
})();
