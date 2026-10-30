// frontend/eta-panel.js
// "On my way" / "Running late" panel for a visit scheduled TODAY, shared by
// the tech visit sheet (tech.js) and the office visit card (generator-care.js)
// so both look and behave the same. The page supplies `send(payload)`, which
// POSTs to its own ETA route (tech: /tech/my-visits/:id/eta, office:
// /visits/:id/eta) and resolves with the backend's result:
//   { sent, can_text, call_phone, message, eta_at, visit }
// A customer who can't be texted is a normal result (can_text=false) and the
// panel shows "call them" with a tap-to-call link - never a failure toast.
// Inline SVG only, no native popups, tokens for color.

(() => {
  const REASONS = [['', 'No reason given'], ['traffic', 'Traffic'], ['previous_job', 'Previous job ran long'], ['other', 'Other']];
  const QUICK = [15, 30, 45, 60];
  const CENTRAL = 'America/Chicago';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const svg = (d) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    truck: svg('<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    phone: svg('<path d="M15.5 20.5c-2.6-.6-5.2-2.1-7.4-4.3S4.4 11.4 3.8 8.8c-.3-1.2 0-2.4.9-3.2l1.3-1.2c.6-.6 1.6-.5 2.1.2l1.7 2.4c.4.6.4 1.4-.1 1.9l-1 1.1c.5 1.1 1.2 2.2 2.2 3.2s2.1 1.7 3.2 2.2l1.1-1c.5-.5 1.3-.5 1.9-.1l2.4 1.7c.7.5.8 1.5.2 2.1l-1.2 1.3c-.8.9-2 1.2-3.2.9z"/>'),
  };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: CENTRAL, hour: 'numeric', minute: '2-digit' }) : '');
  const reasonLabel = (code) => (REASONS.find((r) => r[0] === code) || [])[1] || code;
  const digits = (p) => String(p || '').replace(/[^\d+]/g, '');
  // Running late counts from the ETA the customer already has (same rule as
  // lib/etaTexts.js); once that ETA has slipped by, from now. Null = from now.
  const lateBase = (v) => {
    const t = v.eta_at ? new Date(v.eta_at).getTime() : NaN;
    return Number.isFinite(t) && t > Date.now() ? t : null;
  };

  // mount(el, visit, send, { onUpdate }) - renders into el and keeps `visit`
  // updated from each result so the status line stays current.
  function mount(el, visit, send, opts = {}) {
    const st = { kind: null, minutes: 30, timeVal: '', reason: '', busy: false, result: null, error: null };
    const v = { ...visit };

    function statusLines() {
      const lines = [];
      if (v.en_route_at) lines.push(`${ICON.truck} On my way sent ${esc(fmtTime(v.en_route_at))}${v.eta_at && !v.running_late_at ? `, ETA ${esc(fmtTime(v.eta_at))}` : ''}`);
      if (v.running_late_at) lines.push(`<span class="eta-late">${ICON.clock} Running late sent ${esc(fmtTime(v.running_late_at))}${v.eta_at ? `, new ETA ${esc(fmtTime(v.eta_at))}` : ''}${v.late_reason ? ` (${esc(reasonLabel(v.late_reason))})` : ''}</span>`);
      return lines.length ? `<div class="eta-status">${lines.map((l) => `<div>${l}</div>`).join('')}</div>` : '';
    }

    function quickLabel(m) {
      const base = st.kind === 'running_late' ? lateBase(v) : null;
      return base ? `+${m} min (${esc(fmtTime(new Date(base + m * 60000).toISOString()))})` : `${m} min`;
    }

    function render() {
      const omwLabel = v.en_route_at ? 'Update ETA' : 'On my way';
      const lateTitle = v.eta_at ? `New arrival time <span class="eta-current">(current ETA ${esc(fmtTime(v.eta_at))})</span>` : 'New arrival time';
      const chooser = st.kind ? `
        <div class="eta-chooser" role="group" aria-label="Arrival time">
          <div class="eta-chooser-title">${st.kind === 'running_late' ? lateTitle : (v.en_route_at ? 'Send an updated arrival time' : 'Arrival time')}</div>
          <div class="eta-quick">
            ${QUICK.map((m) => `<button type="button" class="filter${st.minutes === m && !st.timeVal ? ' active' : ''}" data-eta-min="${m}">${quickLabel(m)}</button>`).join('')}
          </div>
          <label class="eta-at">or at <input type="time" data-eta-time value="${esc(st.timeVal)}" aria-label="Arrival time" /></label>
          ${st.kind === 'running_late' ? `<label class="eta-reason">Reason (office only) <select data-eta-reason>${REASONS.map((r) => `<option value="${r[0]}"${st.reason === r[0] ? ' selected' : ''}>${esc(r[1])}</option>`).join('')}</select></label>` : ''}
          <div class="eta-actions">
            <button type="button" class="btn btn-primary btn-sm" data-eta-send${st.busy ? ' disabled' : ''}>${st.busy ? 'Sending…' : 'Send text'}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-eta-cancel${st.busy ? ' disabled' : ''}>Cancel</button>
          </div>
        </div>` : '';
      const result = st.result ? `
        <div class="eta-result${st.result.can_text ? (st.result.sent ? ' ok' : ' warn') : ' warn'}">
          <div>${esc(st.result.message || '')}</div>
          ${!st.result.can_text && st.result.call_phone ? `<a class="btn btn-secondary btn-sm eta-call" href="tel:${esc(digits(st.result.call_phone))}">${ICON.phone} Call ${esc(st.result.call_phone)}</a>` : ''}
        </div>` : '';
      const error = st.error ? `<div class="eta-result warn">${esc(st.error)}</div>` : '';
      el.innerHTML = `<div class="eta-panel">
        ${statusLines()}
        <div class="eta-btns">
          <button type="button" class="btn btn-secondary btn-sm" data-eta-kind="on_my_way"${st.busy ? ' disabled' : ''}>${ICON.truck} ${omwLabel}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-eta-kind="running_late"${st.busy ? ' disabled' : ''}>${ICON.clock} Running late</button>
        </div>
        ${chooser}${result}${error}
      </div>`;
      wire();
    }

    function wire() {
      el.querySelectorAll('[data-eta-kind]').forEach((b) => b.addEventListener('click', () => {
        st.kind = st.kind === b.dataset.etaKind ? null : b.dataset.etaKind;
        st.result = null; st.error = null;
        render();
      }));
      el.querySelectorAll('[data-eta-min]').forEach((b) => b.addEventListener('click', () => { st.minutes = Number(b.dataset.etaMin); st.timeVal = ''; render(); }));
      const t = el.querySelector('[data-eta-time]');
      if (t) t.addEventListener('change', () => { st.timeVal = t.value; render(); });
      const r = el.querySelector('[data-eta-reason]');
      if (r) r.addEventListener('change', () => { st.reason = r.value; });
      const cancel = el.querySelector('[data-eta-cancel]');
      if (cancel) cancel.addEventListener('click', () => { st.kind = null; render(); });
      const sendBtn = el.querySelector('[data-eta-send]');
      if (sendBtn) sendBtn.addEventListener('click', doSend);
    }

    function payload() {
      const p = { kind: st.kind };
      if (st.timeVal) {
        const [hh, mm] = st.timeVal.split(':').map(Number);
        const d = new Date(); d.setHours(hh, mm, 0, 0);
        p.eta_at = d.toISOString();
      } else {
        p.eta_minutes = st.minutes;
      }
      if (st.kind === 'running_late' && st.reason) p.reason = st.reason;
      return p;
    }

    async function doSend() {
      if (st.busy || !st.kind) return;
      const p = payload();
      // "Running late" must move the time later (the backend refuses it too):
      // an earlier time goes out as Update ETA, never under the apology copy.
      if (st.kind === 'running_late' && p.eta_at && v.eta_at && new Date(p.eta_at).getTime() <= new Date(v.eta_at).getTime()) {
        st.result = null;
        st.error = `Running late needs a time after the current ETA (${fmtTime(v.eta_at)}). For an earlier time, use ${v.en_route_at ? 'Update ETA' : 'On my way'}.`;
        render();
        return;
      }
      st.busy = true; st.error = null; st.result = null;
      render();
      try {
        const res = await send(p);
        st.result = res;
        if (res && res.visit) Object.assign(v, res.visit);
        st.kind = null;
        if (opts.onUpdate) opts.onUpdate(res);
      } catch (e) {
        st.error = (e && e.message) || 'Could not send.';
      } finally {
        st.busy = false;
        render();
      }
    }

    render();
    return { refresh: (nv) => { Object.assign(v, nv || {}); render(); } };
  }

  window.BatesEta = { mount, REASONS, reasonLabel, fmtTime };
})();
