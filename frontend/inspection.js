(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
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

  // Selected photos keyed by section (mp/sp/svc/gw/sm/ac/hv). Each value is an
  // array of { file, url } entries parallel to thumbnails in that section's grid.
  const sectionPhotos = {};

  function totalPhotoCount() {
    return Object.values(sectionPhotos).reduce((n, arr) => n + arr.length, 0);
  }

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

  // Rows can declare `showIf: { name, equals }`. The renderer drops the
  // condition onto the wrapper as data-* and `evaluateConditionals()` toggles
  // visibility based on the current radio selection.
  function condAttrs(row) {
    if (!row.showIf) return '';
    return ` data-show-if-name="${row.showIf.name}" data-show-if-equals="${row.showIf.equals}"`;
  }

  function rowHTML(row) {
    if (row.inputType === 'text') {
      return `
        <div class="insp-row"${condAttrs(row)}>
          <div class="insp-row-q">${row.q}</div>
          <div class="insp-row-ctrl"><input type="text" name="${row.name}" class="insp-row-input"></div>
        </div>`;
    }
    const chips = row.opts.map((v) => radioChip(row.name, v, classForOption(v))).join('');
    const sub = row.sub ? `<span class="insp-row-sub">${row.sub}</span>` : '';
    return `
      <div class="insp-row"${condAttrs(row)}>
        <div class="insp-row-q">${row.q}${sub}</div>
        <div class="insp-row-ctrl"><div class="radio-group">${chips}</div></div>
      </div>`;
  }

  // Show/hide rows that declared a `showIf` condition. Cleared inputs in a
  // hidden row are blanked so we don't ship stale values on submit.
  function evaluateConditionals() {
    const form = document.getElementById('inspection-form');
    document.querySelectorAll('[data-show-if-name]').forEach((row) => {
      const name = row.getAttribute('data-show-if-name');
      const want = row.getAttribute('data-show-if-equals');
      const els = form.elements[name];
      let current = '';
      if (els) {
        if (els.length) {
          for (const el of els) if (el.checked) { current = el.value; break; }
        } else {
          current = els.value || '';
        }
      }
      const show = current === want;
      row.hidden = !show;
      if (!show) {
        row.querySelectorAll('input[type="text"]').forEach((i) => { i.value = ''; });
        row.querySelectorAll('input[type="radio"]').forEach((i) => { i.checked = false; });
      }
    });
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
        <span class="upsell-label">${it.label}</span>
        <span class="auto-badge" aria-hidden="true">Auto</span>
      </label>
    `).join('');
  }

  // ---------- auto-recommendations ----------
  // Suggestions ride on top of the form: when an answer indicates a problem,
  // we auto-check the matching upsell so techs don't miss obvious follow-ups.
  // The tech can always uncheck — that's recorded in `dismissed` so we don't
  // re-suggest after they've said no.
  const AUTO_RULES = [
    { upsell: 'up_panel',   when: (d) => d.mp_obs === 'Y' || d.sp_obs === 'Y'
                                       || d.mp_rating === 'Hazard' || d.sp_rating === 'Hazard'
                                       || d.mp_cond === 'Poor' || d.sp_cond === 'Poor' },
    { upsell: 'up_gfci',    when: (d) => d.mp_gfci === 'N' || d.sp_gfci === 'N'
                                       || d.gw_q01 === 'N' || d.gw_q09 === 'N' || d.gw_q02 === 'N' },
    { upsell: 'up_afci',    when: (d) => d.mp_afci === 'N' || d.sp_afci === 'N' || d.gw_q10 === 'N' },
    { upsell: 'up_surge',   when: (d) => d.mp_surge === 'N' || d.mp_surge2 === 'N'
                                       || d.sp_surge === 'N' || d.sp_surge2 === 'N' },
    { upsell: 'up_ground',  when: (d) => d.mp_ground === 'N' || d.sp_ground === 'N' || d.svc_q07 === 'N' },
    { upsell: 'up_alum',    when: (d) => d.mp_wiretype === 'Aluminum' || d.sp_wiretype === 'Aluminum' },
    { upsell: 'up_label',   when: (d) => d.mp_labeled === 'N' || d.sp_labeled === 'N' },
    { upsell: 'up_svc',     when: (d) => d.svc_rating === 'Hazard' },
    { upsell: 'up_outdoor', when: (d) => d.gw_q02 === 'N' },
    { upsell: 'up_covers',  when: (d) => d.gw_q03 === 'N' },
    { upsell: 'up_smoke',   when: (d) => d.sm_q01 === 'N' || d.sm_q02 === 'N' || d.sm_q03 === 'N' },
    { upsell: 'up_co',      when: (d) => d.sm_q04 === 'N' },
  ];

  // Names this run's rules currently want checked. Visual badge follows this.
  const autoSet = new Set();
  // Names the tech explicitly unchecked after we auto-checked them. Sticky:
  // we won't re-suggest until the tech checks the box manually again.
  const dismissed = new Set();

  function upsellCheckbox(name) {
    return document.querySelector(`#upsell-grid input[type="checkbox"][name="${name}"]`);
  }

  function setAutoBadge(name, on) {
    const cb = upsellCheckbox(name);
    if (!cb) return;
    const label = cb.closest('.upsell-item');
    if (!label) return;
    label.classList.toggle('auto-checked', on);
  }

  function updateAutoRecommendations() {
    const data = collectFields();
    const desired = new Set();
    for (const rule of AUTO_RULES) {
      if (rule.when(data)) desired.add(rule.upsell);
    }

    for (const item of UPSELL_ITEMS) {
      const name = item.name;
      const cb = upsellCheckbox(name);
      if (!cb) continue;

      if (desired.has(name) && !dismissed.has(name)) {
        if (!cb.checked) {
          cb.checked = true;
        }
        autoSet.add(name);
        setAutoBadge(name, true);
      } else if (autoSet.has(name) && !desired.has(name)) {
        // Rule used to fire and we'd auto-checked it; rule no longer applies.
        cb.checked = false;
        autoSet.delete(name);
        setAutoBadge(name, false);
      }
    }
  }

  function attachUpsellListeners() {
    for (const item of UPSELL_ITEMS) {
      const cb = upsellCheckbox(item.name);
      if (!cb) continue;
      cb.addEventListener('change', () => {
        const name = item.name;
        if (!cb.checked) {
          // Tech is rejecting a suggestion. Remember that so we don't re-add it.
          if (autoSet.has(name)) {
            dismissed.add(name);
            autoSet.delete(name);
            setAutoBadge(name, false);
          }
          // If they uncheck a manual check (not auto), nothing to track.
        } else {
          // Re-engaging auto management — clear the dismissal so future rule
          // fires can re-suggest naturally. The badge itself is owned by
          // updateAutoRecommendations and gets set on the next change.
          dismissed.delete(name);
        }
      });
    }
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
      // Flatten onto a white canvas before exporting. JPEG has no alpha, so a
      // transparent canvas would otherwise be encoded with a black background
      // (which then shows up behind the signature in the PDF).
      toDataURL: () => {
        if (empty) return null;
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const tctx = tmp.getContext('2d');
        tctx.fillStyle = '#ffffff';
        tctx.fillRect(0, 0, tmp.width, tmp.height);
        tctx.drawImage(canvas, 0, 0);
        return tmp.toDataURL('image/jpeg', 0.6);
      },
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
  // Thumbnails are local previews only; File objects are kept in
  // `sectionPhotos[sectionKey]` and uploaded to Supabase Storage on submit.
  // Auto-retrigger: after a photo is selected we re-open the picker so the tech
  // can keep snapping. The "Done adding photos" button (shown once at least one
  // photo exists) opts out of that loop for the section.
  const autoRetrigger = {};

  function initSectionPhotos() {
    const prompts = window.INSPECTION_PHOTO_PROMPTS || {};
    document.querySelectorAll('[data-photo-section]').forEach((block) => {
      const key = block.getAttribute('data-photo-section');
      sectionPhotos[key] = sectionPhotos[key] || [];
      autoRetrigger[key] = true;

      const promptEl = block.querySelector('.section-photo-prompts');
      const list = prompts[key] || [];
      if (promptEl) {
        promptEl.textContent = list.length
          ? `Recommended: ${list.join(' • ')}`
          : '';
      }

      const grid = block.querySelector('.photo-grid');
      const input = block.querySelector('input[type="file"]');
      const addBtn = block.querySelector('.photo-add');
      if (!grid || !input) return;

      // "Done adding photos" — created once, inserted after the Add button.
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = 'btn-text photo-done';
      doneBtn.textContent = 'Done adding photos';
      doneBtn.hidden = true;
      doneBtn.addEventListener('click', () => {
        autoRetrigger[key] = false;
        doneBtn.hidden = true;
      });
      if (addBtn && addBtn.parentNode) {
        addBtn.parentNode.insertBefore(doneBtn, addBtn.nextSibling);
      }

      const refreshDoneBtn = () => {
        const hasPhotos = sectionPhotos[key].length > 0;
        doneBtn.hidden = !(hasPhotos && autoRetrigger[key]);
      };

      input.addEventListener('change', (e) => {
        const added = e.target.files.length;
        for (const file of e.target.files) {
          const url = URL.createObjectURL(file);
          const entry = { file, url };
          sectionPhotos[key].push(entry);
          const div = document.createElement('div');
          div.className = 'photo-thumb';
          div.innerHTML = `<img src="${url}" alt="photo"><button type="button" class="photo-remove" aria-label="Remove photo">&times;</button>`;
          div.querySelector('.photo-remove').addEventListener('click', () => {
            URL.revokeObjectURL(url);
            const idx = sectionPhotos[key].indexOf(entry);
            if (idx !== -1) sectionPhotos[key].splice(idx, 1);
            div.remove();
            refreshDoneBtn();
          });
          grid.appendChild(div);
        }
        input.value = '';
        refreshDoneBtn();
        // Re-open the picker so multiple shots can be added in a row. The user
        // cancels the picker (or clicks "Done adding photos") to break out.
        if (added > 0 && autoRetrigger[key]) {
          setTimeout(() => input.click(), 0);
        }
      });
    });
  }

  function clearAllSectionPhotos() {
    for (const key of Object.keys(sectionPhotos)) {
      for (const p of sectionPhotos[key]) URL.revokeObjectURL(p.url);
      sectionPhotos[key].length = 0;
      autoRetrigger[key] = true;
    }
    document.querySelectorAll('[data-photo-section] .photo-grid').forEach((g) => {
      g.innerHTML = '';
    });
    document.querySelectorAll('[data-photo-section] .photo-done').forEach((b) => {
      b.hidden = true;
    });
  }

  // ---------- photo upload ----------
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  let cachedConfig = null;
  async function getConfig() {
    if (cachedConfig) return cachedConfig;
    const res = await withTimeout(fetch(`${API_BASE}/config`), 10000, 'Config fetch');
    if (!res.ok) throw new Error('Failed to load config');
    cachedConfig = await res.json();
    return cachedConfig;
  }

  function safeFileName(name) {
    return (name || 'photo.jpg').replace(/[^A-Za-z0-9._-]/g, '_');
  }

  async function uploadOnePhoto(cfg, token, inspectionId, sectionKey, entry, idx) {
    const path = `${inspectionId}/${sectionKey}/${Date.now()}-${idx}-${safeFileName(entry.file.name)}`;
    const storageUrl = `${cfg.supabaseUrl}/storage/v1/object/inspection-photos/${path}`;
    const storageRes = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': cfg.supabaseAnonKey,
        'Content-Type': entry.file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: entry.file,
    });
    if (!storageRes.ok) {
      const body = await storageRes.text().catch(() => '');
      throw new Error(`Storage upload failed (${storageRes.status}): ${body}`);
    }

    const rowRes = await fetch(`${cfg.supabaseUrl}/rest/v1/inspection_photos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': cfg.supabaseAnonKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ inspection_id: inspectionId, storage_path: path }),
    });
    if (!rowRes.ok) {
      const body = await rowRes.text().catch(() => '');
      throw new Error(`DB insert failed (${rowRes.status}): ${body}`);
    }
  }

  async function uploadPhotos(inspectionId, token, onProgress) {
    const total = totalPhotoCount();
    let cfg;
    try {
      cfg = await getConfig();
    } catch (e) {
      console.error(e);
      return { uploaded: 0, failed: total };
    }
    let uploaded = 0;
    let failed = 0;
    let idx = 0;
    for (const sectionKey of Object.keys(sectionPhotos)) {
      const arr = sectionPhotos[sectionKey];
      for (const entry of arr) {
        try {
          await withTimeout(
            uploadOnePhoto(cfg, token, inspectionId, sectionKey, entry, idx),
            45000,
            'Photo upload'
          );
          uploaded++;
        } catch (e) {
          console.error('Photo upload failed', e);
          failed++;
        }
        idx++;
        if (onProgress) onProgress(uploaded + failed);
      }
    }
    return { uploaded, failed };
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
        // Store the label (el.value) when checked so downstream renderers can
        // print the label directly instead of a useless `true`. Empty string
        // for unchecked keeps the field present for clarity.
        out[el.name] = el.checked ? el.value : '';
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
    form.addEventListener('change', evaluateConditionals);
    form.addEventListener('change', updateAutoRecommendations);
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  }

  // ---------- submission ----------
  async function submitInspection() {
    const submitBtn = document.getElementById('submit-btn');
    const originalSubmitText = submitBtn ? submitBtn.textContent : '';
    const setSubmitButton = (text, disabled) => {
      if (!submitBtn) return;
      submitBtn.textContent = text;
      submitBtn.disabled = !!disabled;
    };
    const restoreSubmitButton = () => setSubmitButton(originalSubmitText, false);

    // Collect all form data
    const formData = collectFields();
    formData.sigTech = signatures.sigTech ? signatures.sigTech.toDataURL() : null;
    formData.sigCust = signatures.sigCust ? signatures.sigCust.toDataURL() : null;

    setSubmitButton('Submitting...', true);
    showStatus('Submitting inspection...', 'info');

    const token = getToken();
    const payload = {
      data: formData,
      status: 'submitted',
    };

    // ----- Step 1: POST inspection (the source-of-truth save) -----
    // If this fails, we fall back to EmailJS. If it succeeds, we are committed
    // to the success path — nothing below may fall back to the EmailJS branch.
    let inspectionId = null;
    try {
      const response = await fetch(`${API_BASE}/inspections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let errMsg = `Backend submission failed (${response.status})`;
        try {
          const errBody = await response.json();
          if (errBody && errBody.error) errMsg = errBody.error;
        } catch (_) {}
        throw new Error(errMsg);
      }
      const result = await response.json().catch(() => ({}));
      inspectionId = (result && result.inspection && result.inspection.id) || null;
    } catch (backendErr) {
      console.warn('Backend submission failed, trying EmailJS fallback:', backendErr);
      try {
        await submitViaEmailJS(formData);
        showStatus('✓ Inspection submitted via email (fallback). Server may be offline.', 'warning');
        setSubmitButton('Submitted!', true);
        clearDraft();
        setTimeout(() => window.location.replace('home.html'), 3000);
      } catch (emailErr) {
        showStatus(`Submission failed: ${emailErr.message}. Please try again.`, 'error');
        restoreSubmitButton();
      }
      return;
    }

    // ----- Step 2: Upload photos (best-effort; never blocks success) -----
    const totalPhotos = totalPhotoCount();
    let uploadResult = null;
    if (inspectionId && totalPhotos > 0) {
      setSubmitButton(`Uploading photos (0/${totalPhotos})...`, true);
      showStatus(`Uploading 0/${totalPhotos} photos...`, 'info');
      try {
        uploadResult = await uploadPhotos(inspectionId, token, (done) => {
          setSubmitButton(`Uploading photos (${done}/${totalPhotos})...`, true);
          showStatus(`Uploading ${done}/${totalPhotos} photos...`, 'info');
        });
      } catch (photoErr) {
        // uploadPhotos shouldn't throw, but defend against it just in case so
        // an unexpected error here can't prevent us from reaching the success
        // state — the inspection is already saved on the server.
        console.error('Photo upload threw unexpectedly:', photoErr);
        uploadResult = { uploaded: 0, failed: totalPhotos };
      }
    }

    // ----- Step 3: Show success (always, since the inspection saved) -----
    let successMsg;
    let kind = 'success';
    if (uploadResult && uploadResult.failed > 0) {
      kind = 'warning';
      if (uploadResult.uploaded > 0) {
        successMsg = `✓ Inspection submitted! Uploaded ${uploadResult.uploaded}/${totalPhotos} photos (${uploadResult.failed} failed).`;
      } else {
        successMsg = '✓ Inspection submitted! Photos failed to upload — check your connection.';
      }
    } else if (uploadResult && uploadResult.uploaded > 0) {
      const n = uploadResult.uploaded;
      successMsg = `✓ Inspection submitted successfully with ${n} photo${n === 1 ? '' : 's'}!`;
    } else {
      successMsg = '✓ Inspection submitted successfully!';
    }

    showStatus(successMsg, kind);
    setSubmitButton('Submitted!', true);
    clearDraft();
    clearAllSectionPhotos();
    setTimeout(() => window.location.replace('home.html'), 3000);
  }

  async function submitViaEmailJS(formData) {
    // Load EmailJS if not already loaded
    if (!window.emailjs) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@3.11.0/dist/browser.min.js';
      script.onload = () => {
        window.emailjs.init('DeDPpeJ2O4A0B17_E');
      };
      script.onerror = () => { throw new Error('Failed to load EmailJS'); };
      document.head.appendChild(script);

      // Wait for script to load
      return new Promise((resolve, reject) => {
        const checkLoaded = setInterval(() => {
          if (window.emailjs) {
            clearInterval(checkLoaded);
            submitEmailJSTemplate(formData, resolve, reject);
          }
        }, 100);
        setTimeout(() => {
          clearInterval(checkLoaded);
          reject(new Error('EmailJS failed to load'));
        }, 5000);
      });
    } else {
      return submitEmailJSTemplate(formData);
    }
  }

  function submitEmailJSTemplate(formData, resolve, reject) {
    const emailBody = buildEmailHTML(formData);
    const custEmail = formData.job_email || '';
    const custName = formData.job_cust || 'Customer';
    const date = formData.job_date || new Date().toLocaleDateString();

    const templateParams = {
      to_email: 'cjbates@bates-electric.com',
      cc_email: custEmail,
      subject: `Bates Electric Safety Inspection — ${custName} — ${date}`,
      html_body: emailBody,
    };

    window.emailjs.send('service_9o854p5', 'template_j94dma6', templateParams)
      .then(() => {
        if (resolve) resolve();
      })
      .catch((err) => {
        if (reject) reject(new Error(`EmailJS error: ${err.message}`));
      });
  }

  function buildEmailHTML(data) {
    const d = data || {};
    const date = d.job_date || new Date().toLocaleDateString();
    const techName = d.job_tech || 'Tech';
    const custName = d.job_cust || 'Customer';
    const custEmail = d.job_email || '';

    let html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
<h2 style="color: #0B2545; border-bottom: 3px solid #F5B700; padding-bottom: 10px;">Bates Electric &mdash; Electrical Safety Inspection</h2>

<h3 style="color: #0B2545; margin-top: 20px;">Job Information</h3>
<table style="width: 100%; border-collapse: collapse;">
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Date:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${date}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Job #:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_num || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Invoice #:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_inv || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Technician:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${techName}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Customer:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${custName}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Address:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_addr || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Email:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${custEmail}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Year Built:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_yr || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Property Type:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_type || ''}</td></tr>
</table>
    `;

    // Helper to add section
    const addSection = (title, fields) => {
      html += `<h3 style="color: #0B2545; margin-top: 20px;">${title}</h3>
<table style="width: 100%; border-collapse: collapse;">`;
      fields.forEach(([label, key]) => {
        const val = d[key];
        if (val) {
          html += `<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>${label}:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${val}</td></tr>`;
        }
      });
      html += `</table>`;
    };

    // Main panels
    const mpFields = [
      ['Manufacturer', 'mp_mfr'], ['Voltage', 'mp_volt'], ['Amps', 'mp_amps'],
      ['Phase', 'mp_phase'], ['Age', 'mp_age'], ['Obsolete', 'mp_obs'],
      ['UL Listed', 'mp_ul'], ['Breakers sized', 'mp_sized'], ['Main breaker protected', 'mp_main_breaker'],
      ['Main breaker sized', 'mp_main_sized'], ['GFCI working', 'mp_gfci'], ['AFCI working', 'mp_afci'],
      ['Burning/corrosion', 'mp_burn'], ['Connections tight', 'mp_tight'], ['Wire type', 'mp_wiretype'],
      ['Grounding correct', 'mp_ground'], ['Surge device', 'mp_surge'], ['Clamps/bushings', 'mp_clamps'],
      ['Panel labeled', 'mp_labeled'], ['Knockouts sealed', 'mp_knockouts'], ['Bonded', 'mp_bonded'],
      ['Heat', 'mp_heat'], ['Corrosion', 'mp_corr'], ['Water/rust', 'mp_rust'],
      ['Double taps', 'mp_dbl_tap'], ['Surge protector', 'mp_surge2'], ['Breakers for wire', 'mp_wire_size'],
      ['Condition', 'mp_cond'], ['Exposed wires', 'mp_exposed'], ['Entries protected', 'mp_entries'],
      ['Overall rating', 'mp_rating']
    ];
    addSection('Main Electrical Panel', mpFields);

    const spFields = mpFields.map(([l, k]) => [l, k.replace('mp_', 'sp_')]);
    addSection('Secondary / Sub Panel', spFields);

    const svcFields = [
      ['Ampere Rating', 'svc_amps'], ['Phase', 'svc_phase'], ['Age', 'svc_age'],
      ['Riser Type', 'svc_riser'], ['POA Condition', 'svc_poa'],
      ['Entry', 'svc_entry'], ['Location', 'svc_loc'],
      ['Disconnect switch', 'svc_q01'], ['Eyebolt', 'svc_q02'], ['Weatherhead', 'svc_q03'],
      ['Flashing', 'svc_q04'], ['Utility connections', 'svc_q05'], ['Trees on wires', 'svc_q06'],
      ['Grounding', 'svc_q07'], ['Drip loop', 'svc_q08'], ['Components secured', 'svc_q09'],
      ['Meter/Service', 'svc_q10'], ['Entrance cable', 'svc_q11'], ['Overall rating', 'svc_rating']
    ];
    addSection('Main Electrical Service', svcFields);

    const gwFields = [
      ['GFCI in required', 'gw_q01'], ['Outside GFCI', 'gw_q02'], ['Bubble covers', 'gw_q03'],
      ['Outside wiring', 'gw_q04'], ['Open splices', 'gw_q05'], ['Stab wired', 'gw_q06'],
      ['Extension cords', 'gw_q07'], ['Outlets', 'gw_q08'], ['GFCI coverage', 'gw_q09'],
      ['AFCI coverage', 'gw_q10'], ['Fixtures', 'gw_q11'], ['Exhaust fans', 'gw_q12'],
      ['Charging stations', 'gw_q13'], ['Colors noted', 'gw_colors'], ['Overall rating', 'gw_rating']
    ];
    addSection('General Wiring', gwFields);

    const smFields = [
      ['Tested/working', 'sm_q01'], ['In required areas', 'sm_q02'], ['Hardwired/interconnected', 'sm_q03'],
      ['CO alarms', 'sm_q04'], ['Doorbell', 'sm_q05'], ['Detector age', 'sm_age'], ['Overall rating', 'sm_rating']
    ];
    addSection('Smoke & CO Alarms', smFields);

    const acFields = [
      ['Wiring correct', 'ac_q01'], ['Count', 'ac_count'], ['Improper methods', 'ac_q03'], ['Overall rating', 'ac_rating']
    ];
    addSection('Attic & Crawlspace', acFields);

    const hvFields = [
      ['AC Min', 'hv_min'], ['AC Max', 'hv_max'],
      ['AC breaker correct', 'hv_q01'], ['AC disconnect', 'hv_q02'], ['Furnace wiring', 'hv_q03'],
      ['Furnace disconnect', 'hv_q04'], ['Aluminum wiring', 'hv_q05'], ['Aluminum terminated', 'hv_q06'],
      ['A/C condition', 'hv_q07'], ['Furnace condition', 'hv_q08'], ['Overall rating', 'hv_rating']
    ];
    addSection('Furnace & A/C Wiring', hvFields);

    // Recommended services. Items from window.INSPECTION_UPSELL_ITEMS provide
    // canonical labels; old drafts may have `true` instead of a label string.
    const upsellItems = (window.INSPECTION_UPSELL_ITEMS || []);
    const checked = [];
    upsellItems.forEach(({ name, label }) => {
      const v = d[name];
      if (!v) return;
      checked.push(typeof v === 'string' ? v : label);
    });
    if (checked.length || d.up_other) {
      html += `<h3 style="color: #0B2545; margin-top: 20px;">Recommended Services</h3>`;
      if (checked.length) html += `<p>${checked.join(', ')}</p>`;
      if (d.up_other) html += `<p><strong>Other:</strong> ${d.up_other}</p>`;
    }

    // Notes
    if (d.insp_notes) {
      html += `<h3 style="color: #0B2545; margin-top: 20px;">Notes</h3><p>${d.insp_notes.replace(/\n/g, '<br>')}</p>`;
    }

    // Signatures
    html += `<h3 style="color: #0B2545; margin-top: 20px;">Signatures</h3>
<table style="width: 100%; border-collapse: collapse;">
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Technician Name:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.sig_tech_name || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Date:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.sig_date || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Customer Name:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.sig_cust_name || ''}</td></tr>
</table>`;

    html += `</body></html>`;
    return html;
  }

  // ---------- actions ----------
  function wireActions() {
    document.getElementById('reset-btn').addEventListener('click', () => {
      if (!confirm('Reset the entire inspection? This cannot be undone.')) return;
      document.getElementById('inspection-form').reset();
      clearDraft();
      Object.values(signatures).forEach((s) => s.clear());
      clearAllSectionPhotos();
      autoSet.forEach((n) => setAutoBadge(n, false));
      autoSet.clear();
      dismissed.clear();
      evaluateConditionals();
      showStatus('Inspection reset.', 'info');
    });

    document.getElementById('save-draft-btn').addEventListener('click', () => {
      saveDraft();
      showStatus('Draft saved locally.', 'info');
    });

    document.getElementById('inspection-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitInspection();
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
  attachUpsellListeners();
  initSignatures();
  initSectionPhotos();
  restoreDraft();
  evaluateConditionals();
  updateAutoRecommendations();
  attachAutosave();
  wireActions();
})();
