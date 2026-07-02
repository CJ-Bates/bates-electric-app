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
      doneBtn.className = 'btn btn-text photo-done';
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
          div.innerHTML = `<img src="${url}" alt="photo"><button type="button" class="photo-remove" aria-label="Remove photo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
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
    // Only this block can show a submission error. Once it succeeds we are
    // committed to the success path — no code below may treat the inspection
    // as having failed, because it has already been saved on the server.
    let inspectionId = null;
    try {
      const response = await BatesAuth.authFetch(`${API_BASE}/inspections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let errMsg = `Submission failed (${response.status})`;
        try {
          const errBody = await response.json();
          if (errBody && errBody.error) errMsg = errBody.error;
        } catch (_) {}
        throw new Error(errMsg);
      }
      const result = await response.json().catch(() => ({}));
      inspectionId = (result && result.inspection && result.inspection.id) || null;
    } catch (backendErr) {
      console.error('Inspection submission failed:', backendErr);
      showStatus(`Submission failed: ${backendErr.message}. Please try again.`, 'error');
      restoreSubmitButton();
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
    if (uploadResult && uploadResult.failed > 0) {
      if (uploadResult.uploaded > 0) {
        successMsg = `Your inspection has been submitted. ${uploadResult.uploaded} of ${totalPhotos} photos uploaded (${uploadResult.failed} failed — check your connection).`;
      } else {
        successMsg = 'Your inspection has been submitted, but photos failed to upload. Please check your connection.';
      }
    } else if (uploadResult && uploadResult.uploaded > 0) {
      const n = uploadResult.uploaded;
      successMsg = `Your inspection has been submitted successfully with ${n} photo${n === 1 ? '' : 's'}.`;
    } else {
      successMsg = 'Your inspection has been submitted successfully.';
    }

    setSubmitButton('Submitted!', true);
    clearDraft();
    clearAllSectionPhotos();
    showSubmitSuccessModal(successMsg);
  }

  function showSubmitSuccessModal(message) {
    const modal = document.getElementById('submit-success-modal');
    const msgEl = document.getElementById('submit-success-message');
    const okBtn = document.getElementById('submit-success-ok-btn');
    if (!modal || !okBtn) {
      // Fallback: if the modal isn't in the DOM for some reason, fall back to
      // the inline status + redirect so the user still gets some confirmation.
      showStatus(message, 'success');
      setTimeout(() => window.location.replace('home.html'), 3000);
      return;
    }
    if (msgEl) msgEl.textContent = message;
    // Hide the inline status — the modal is the canonical confirmation now.
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.hidden = true;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const goHome = () => { window.location.replace('home.html'); };
    okBtn.addEventListener('click', goHome, { once: true });
    // Tap outside the modal also dismisses.
    const overlay = modal.querySelector('.modal-overlay');
    if (overlay) overlay.addEventListener('click', goHome, { once: true });
    okBtn.focus();
  }

  // ---------- actions ----------
  function wireActions() {
    document.getElementById('reset-btn').addEventListener('click', async () => {
      if (!await openConfirm({ title: 'Reset inspection?', message: 'This clears the entire form. This cannot be undone.', confirmText: 'Reset', danger: true })) return;
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
