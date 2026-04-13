(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : '';
  const TOKEN_KEY = 'bates.auth.token';
  const DRAFT_KEY = 'bates.inspection.draft';

  const getToken = () =>
    localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

  if (!getToken()) {
    window.location.replace('index.html');
    return;
  }

  const ROW_GROUPS = window.INSPECTION_ROW_GROUPS;
  const UPSELL_ITEMS = window.INSPECTION_UPSELL_ITEMS;

  // Holds { clear, isEmpty, toDataURL, restoreFromDataURL } per canvas id.
  const signatures = {};

  // ---------- build repetitive rows from data ----------
  function radioChip(name, value, cls) {
    return `<label class="radio-opt ${cls}"><input type="radio" name="${name}" value="${value}"><span class="radio-chip">${value}</span></label>`;
  }

  function classForOption(v) {
    const map = { Y: 'r-y', N: 'r-n', NA: 'r-na', Good: 'r-good', Fair: 'r-fair', Poor: 'r-poor',
                  Safe: 'r-good', Risk: 'r-fair', Hazard: 'r-poor',
                  Copper: 'r-cu', Aluminum: 'r-al', Overhead: 'r-n', Underground: 'r-y',
                  Pole: 'r-n', Building: 'r-y' };
    return map[v] || '';
  }

  function rowHTML(row) {
    if (row.inputType === 'text') {
      return `
        <div class="insp-row">
          <div class="insp-row-q">${row.q}</div>
          <div class="insp-row-ctrl"><input type="text" name="${row.name}" class="insp-row-input"></div>
        </div>`;
    }
    const chips = row.opts.map((v) => radioChip(row.name, v, classForOption(v))).join('');
    const sub = row.sub ? `<span class="insp-row-sub">${row.sub}</span>` : '';
    return `
      <div class="insp-row">
        <div class="insp-row-q">${row.q}${sub}</div>
        <div class="insp-row-ctrl"><div class="radio-group">${chips}</div></div>
      </div>`;
  }

  function renderRows() {
    document.querySelectorAll('[data-rows]').forEach((container) => {
      const key = container.getAttribute('data-rows');
      const rows = ROW_GROUPS[key] || [];
      container.innerHTML = rows.map(rowHTML).join('');
    });
  }

  function renderUpsell() {
    const grid = document.getElementById('upsell-grid');
    grid.innerHTML = UPSELL_ITEMS.map((it) => `
      <label class="upsell-item">
        <input type="checkbox" name="${it.name}" value="${it.label}">
        <span>${it.label}</span>
      </label>
    `).join('');
  }

  // ---------- signature canvases ----------
  function initSignature(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0B2545';

    let drawing = false;
    let last = null;
    let empty = true;

    const pointer = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
      return {
        x: x * (canvas.width / rect.width),
        y: y * (canvas.height / rect.height),
      };
    };

    const start = (e) => {
      e.preventDefault();
      drawing = true;
      last = pointer(e);
      empty = false;
    };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pointer(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    };
    const end = () => {
      if (!drawing) return;
      drawing = false;
      last = null;
      scheduleSave();
    };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      clear: () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        empty = true;
      },
      isEmpty: () => empty,
      toDataURL: () => (empty ? null : canvas.toDataURL('image/jpeg', 0.6)),
      restoreFromDataURL: (dataUrl) => {
        if (!dataUrl) return;
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          empty = false;
        };
        img.src = dataUrl;
      },
    };
  }

  function initSignatures() {
    document.querySelectorAll('.sig-canvas').forEach((c) => {
      signatures[c.id] = initSignature(c);
    });
    document.querySelectorAll('[data-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-clear');
        if (signatures[id]) {
          signatures[id].clear();
          scheduleSave();
        }
      });
    });
  }

  // ---------- photos ----------
  // Piece 3 only shows local previews. Uploading to Supabase Storage comes
  // in Piece 6, and photos are intentionally NOT written to localStorage.
  function initPhotos() {
    const grid = document.getElementById('photo-grid');
    const input = document.getElementById('photo-input');
    input.addEventListener('change', (e) => {
      for (const file of e.target.files) {
        const url = URL.createObjectURL(file);
        const div = document.createElement('div');
        div.className = 'photo-thumb';
        div.innerHTML = `<img src="${url}" alt="photo"><button type="button" class="photo-remove" aria-label="Remove photo">&times;</button>`;
        div.querySelector('.photo-remove').addEventListener('click', () => {
          URL.revokeObjectURL(url);
          div.remove();
        });
        grid.appendChild(div);
      }
      input.value = '';
    });
  }

  // ---------- autosave / restore ----------
  function collectFields() {
    const form = document.getElementById('inspection-form');
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'radio') {
        if (el.checked) out[el.name] = el.value;
      } else if (el.type === 'checkbox') {
        out[el.name] = el.checked;
      } else if (el.type === 'file' || el.type === 'button' || el.type === 'submit') {
        // skip
      } else {
        out[el.name] = el.value;
      }
    }
    return out;
  }

  function applyFields(data) {
    if (!data) return;
    const form = document.getElementById('inspection-form');
    for (const el of form.elements) {
      if (!el.name || !(el.name in data)) continue;
      if (el.type === 'radio') {
        el.checked = (el.value === data[el.name]);
      } else if (el.type === 'checkbox') {
        el.checked = !!data[el.name];
      } else if (el.type === 'file' || el.type === 'button' || el.type === 'submit') {
        // skip
      } else {
        el.value = data[el.name] ?? '';
      }
    }
  }

  function saveDraft() {
    try {
      const payload = {
        fields: collectFields(),
        sigTech: signatures.sigTech ? signatures.sigTech.toDataURL() : null,
        sigCust: signatures.sigCust ? signatures.sigCust.toDataURL() : null,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
      flashSavedBadge();
    } catch (err) {
      // Most likely QuotaExceededError — fall back to fields-only if signatures overflow.
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          fields: collectFields(),
          savedAt: new Date().toISOString(),
        }));
        flashSavedBadge();
      } catch (_) {
        console.warn('Autosave failed:', err);
      }
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 400);
  }

  function flashSavedBadge() {
    const badge = document.getElementById('autosave-badge');
    if (!badge) return;
    badge.classList.add('visible');
    clearTimeout(flashSavedBadge._t);
    flashSavedBadge._t = setTimeout(() => badge.classList.remove('visible'), 1200);
  }

  function restoreDraft() {
    let raw;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (_) { return; }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    applyFields(data.fields);
    if (signatures.sigTech && data.sigTech) signatures.sigTech.restoreFromDataURL(data.sigTech);
    if (signatures.sigCust && data.sigCust) signatures.sigCust.restoreFromDataURL(data.sigCust);
  }

  function attachAutosave() {
    const form = document.getElementById('inspection-form');
    form.addEventListener('input', scheduleSave);
    form.addEventListener('change', scheduleSave);
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  }

  // ---------- actions ----------
  function wireActions() {
    document.getElementById('reset-btn').addEventListener('click', () => {
      if (!confirm('Reset the entire inspection? This cannot be undone.')) return;
      document.getElementById('inspection-form').reset();
      clearDraft();
      Object.values(signatures).forEach((s) => s.clear());
      document.getElementById('photo-grid').innerHTML = '';
      showStatus('Inspection reset.', 'info');
    });

    document.getElementById('save-draft-btn').addEventListener('click', () => {
      saveDraft();
      showStatus('Draft saved locally. Server-side draft saving comes in the next step.', 'info');
    });

    document.getElementById('inspection-form').addEventListener('submit', (e) => {
      e.preventDefault();
      showStatus('Submission will be wired up in the next step.', 'info');
    });
  }

  function showStatus(msg, kind = 'info') {
    const el = document.getElementById('status');
    el.hidden = false;
    el.className = `status ${kind}`;
    el.textContent = msg;
  }

  // ---------- init ----------
  renderRows();
  renderUpsell();
  initSignatures();
  initPhotos();
  restoreDraft();
  attachAutosave();
  wireActions();
})();
