(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
  const TOKEN_KEY = 'bates.auth.token';

  const getToken = () =>
    localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

  // Check auth and role
  const token = getToken();
  if (!token) {
    window.location.replace('index.html');
    return;
  }

  // Verify office role
  async function checkRole() {
    try {
      const response = await BatesAuth.authFetch(`${API_BASE}/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to get profile');
      const { profile } = await response.json();
      if (profile.role !== 'office') {
        showStatus('Access denied. Office role required.', 'error');
        setTimeout(() => window.location.replace('home.html'), 1500);
      }
    } catch (err) {
      console.error('Role check failed:', err);
      showStatus('Failed to verify role.', 'error');
    }
  }

  // State
  let allInspections = [];
  const filterState = {
    customer: '',
    job: '',
    dateStart: '',
    dateEnd: ''
  };
  let currentDetailId = null;

  // Load inspections
  async function loadInspections() {
    showLoading(true);
    setError(null);
    try {
      const response = await BatesAuth.authFetch(`${API_BASE}/inspections?status=submitted&limit=200`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
      }
      const { inspections } = await response.json();
      allInspections = inspections || [];
      renderInspections();
      showLoading(false);
    } catch (err) {
      console.error('Load failed:', err);
      setError(`Failed to load inspections: ${err.message}`);
      showLoading(false);
    }
  }

  function setError(msg) {
    let el = document.getElementById('error-state');
    if (!el) {
      el = document.createElement('div');
      el.id = 'error-state';
      el.className = 'error-state';
      document.querySelector('.dashboard-content').prepend(el);
    }
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  // Filter and sort inspections
  function getFilteredInspections() {
    return allInspections
      .filter(insp => {
        if (filterState.customer && !insp.customer_name?.toLowerCase().includes(filterState.customer.toLowerCase())) {
          return false;
        }
        if (filterState.job && !insp.job_number?.toString().includes(filterState.job)) {
          return false;
        }
        if (filterState.dateStart && insp.job_date < filterState.dateStart) {
          return false;
        }
        if (filterState.dateEnd && insp.job_date > filterState.dateEnd) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Newest first
        return new Date(b.job_date || b.created_at) - new Date(a.job_date || a.created_at);
      });
  }

  // Render inspections as grid of cards
  function renderInspections() {
    const filtered = getFilteredInspections();
    const container = document.getElementById('inspections-container');
    const empty = document.getElementById('empty');
    const countEl = document.getElementById('result-count');
    if (countEl) {
      const total = allInspections.length;
      const shown = filtered.length;
      countEl.textContent = total === shown ? `${total} submitted` : `${shown} of ${total} submitted`;
    }

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    container.innerHTML = filtered.map(insp => {
      const date = insp.job_date ? new Date(insp.job_date).toLocaleDateString() : 'N/A';
      // Prefer the resolved profile name; fall back to a shortened id only if
      // the profile is gone (deleted account).
      const techLabel = insp.technician_name
        ? `Tech: ${escapeHtml(insp.technician_name)}`
        : (insp.technician_id ? `Tech: ${insp.technician_id.substring(0, 8)}\u2026` : 'Tech: Unknown');
      return `
        <div class="insp-card" data-id="${insp.id}">
          <div class="insp-card-header">
            <div class="insp-card-date">${date}</div>
            <div class="insp-card-status ${insp.status}">${insp.status}</div>
          </div>
          <div class="insp-card-body">
            <h3>${insp.customer_name || 'Unknown Customer'}</h3>
            <div class="insp-card-meta">
              <p><strong>Job #:</strong> ${insp.job_number || 'N/A'}</p>
              <p><strong>Email:</strong> ${insp.customer_email || 'N/A'}</p>
              <p><strong>${techLabel}</strong></p>
            </div>
          </div>
          <div class="insp-card-footer">
            <button type="button" class="btn-secondary btn-sm view-btn" data-id="${insp.id}">View Details</button>
            <button type="button" class="btn-danger btn-sm delete-btn" data-id="${insp.id}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    // Wire up card buttons
    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        showDetails(id);
      });
    });

    container.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (await openConfirm({ title: 'Delete inspection?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true })) {
          deleteInspection(id);
        }
      });
    });

    // Also allow clicking the card itself
    container.querySelectorAll('.insp-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('button')) {
          const id = card.dataset.id;
          showDetails(id);
        }
      });
    });
  }

  // Show details modal
  async function showDetails(id) {
    try {
      const response = await BatesAuth.authFetch(`${API_BASE}/inspections/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to load inspection details');
      const { inspection } = await response.json();

      currentDetailId = id;
      const modal = document.getElementById('detailsModal');
      const title = document.getElementById('modal-title');
      const body = document.getElementById('modal-body');

      title.textContent = `Inspection for ${inspection.customer_name || 'Customer'}`;

      // Build details HTML
      let html = `<div class="details-content">`;

      // Basic info
      const data = inspection.data || {};
      html += `
        <h3 class="details-section-title">Job Information</h3>
        <table class="details-table">
          <tr><td><strong>Date:</strong></td><td>${inspection.job_date || 'N/A'}</td></tr>
          <tr><td><strong>Job #:</strong></td><td>${inspection.job_number || 'N/A'}</td></tr>
          <tr><td><strong>Invoice #:</strong></td><td>${data.job_inv || 'N/A'}</td></tr>
          <tr><td><strong>Customer:</strong></td><td>${inspection.customer_name || 'N/A'}</td></tr>
          <tr><td><strong>Address:</strong></td><td>${data.job_addr || 'N/A'}</td></tr>
          <tr><td><strong>Email:</strong></td><td>${inspection.customer_email || 'N/A'}</td></tr>
          <tr><td><strong>Technician:</strong></td><td>${data.job_tech || 'N/A'}</td></tr>
          <tr><td><strong>Year Built:</strong></td><td>${data.job_yr || 'N/A'}</td></tr>
          <tr><td><strong>Property Type:</strong></td><td>${data.job_type || 'N/A'}</td></tr>
        </table>
      `;

      // Main panel
      html += `
        <h3 class="details-section-title">Main Electrical Panel</h3>
        <table class="details-table">
          <tr><td><strong>Manufacturer:</strong></td><td>${data.mp_mfr || 'N/A'}</td></tr>
          <tr><td><strong>Voltage:</strong></td><td>${data.mp_volt || 'N/A'}</td></tr>
          <tr><td><strong>Ampere Rating:</strong></td><td>${data.mp_amps || 'N/A'}</td></tr>
          <tr><td><strong>Phase:</strong></td><td>${data.mp_phase || 'N/A'}</td></tr>
          <tr><td><strong>Age:</strong></td><td>${data.mp_age || 'N/A'}</td></tr>
          <tr><td><strong>Obsolete?:</strong></td><td>${data.mp_obs || 'N/A'}</td></tr>
          <tr><td><strong>UL Listed?:</strong></td><td>${data.mp_ul || 'N/A'}</td></tr>
          <tr><td><strong>Breakers Sized?:</strong></td><td>${data.mp_sized || 'N/A'}</td></tr>
          <tr><td><strong>Panel Overall Rating:</strong></td><td><strong style="color: ${ratingColor(data.mp_rating)}">${data.mp_rating || 'N/A'}</strong></td></tr>
        </table>
      `;

      // Sub panel
      html += `
        <h3 class="details-section-title">Secondary / Sub Panel</h3>
        <table class="details-table">
          <tr><td><strong>Manufacturer:</strong></td><td>${data.sp_mfr || 'N/A'}</td></tr>
          <tr><td><strong>Voltage:</strong></td><td>${data.sp_volt || 'N/A'}</td></tr>
          <tr><td><strong>Overall Rating:</strong></td><td><strong style="color: ${ratingColor(data.sp_rating)}">${data.sp_rating || 'N/A'}</strong></td></tr>
        </table>
      `;

      // Service
      html += `
        <h3 class="details-section-title">Main Electrical Service</h3>
        <table class="details-table">
          <tr><td><strong>Ampere Rating:</strong></td><td>${data.svc_amps || 'N/A'}</td></tr>
          <tr><td><strong>Riser Type:</strong></td><td>${data.svc_riser || 'N/A'}</td></tr>
          <tr><td><strong>Overall Rating:</strong></td><td><strong style="color: ${ratingColor(data.svc_rating)}">${data.svc_rating || 'N/A'}</strong></td></tr>
        </table>
      `;

      // Recommended services. Older inspections stored `true` per checkbox;
      // newer ones store the label string. Fall back to a label lookup when
      // we encounter the legacy `true` shape.
      const upsellLabels = {
        up_panel: 'Panel upgrade / replacement',
        up_surge: 'Whole-home surge protector',
        up_breaker: 'Main breaker replacement',
        up_gfci: 'GFCI outlet installation',
        up_afci: 'AFCI breaker installation',
        up_ev: 'EV charging outlet (240V)',
        up_sub: 'Subpanel installation',
        up_circuit: 'Dedicated circuit(s)',
        up_smoke: 'Smoke detector replacement',
        up_co: 'CO detector installation',
        up_alum: 'Aluminum wiring remediation',
        up_arc: 'Arc fault protection upgrade',
        up_svc: 'Service upgrade (100A → 200A)',
        up_gen: 'Whole-home generator / transfer sw.',
        up_outdoor: 'Outdoor / weatherproof outlets',
        up_covers: 'In-use outlet covers installation',
        up_label: 'Label / map panel circuits',
        up_ground: 'Grounding / bonding correction',
      };
      const checked = [];
      Object.keys(upsellLabels).forEach((n) => {
        const v = data[n];
        if (!v) return;
        checked.push(typeof v === 'string' ? v : upsellLabels[n]);
      });
      if (checked.length || data.up_other) {
        html += `<h3 class="details-section-title">Recommended Services</h3><p>`;
        if (checked.length) html += checked.join('<br>');
        if (checked.length && data.up_other) html += '<br>';
        if (data.up_other) html += `<strong>Other:</strong> ${data.up_other}`;
        html += `</p>`;
      }

      // Notes
      if (data.insp_notes) {
        html += `
          <h3 class="details-section-title">Notes</h3>
          <p style="white-space: pre-wrap; background: #f5f5f5; padding: 12px; border-radius: 6px;">${escapeHtml(data.insp_notes)}</p>
        `;
      }

      // Signatures
      html += `
        <h3 class="details-section-title">Signatures</h3>
        <table class="details-table">
          <tr><td><strong>Technician:</strong></td><td>${data.sig_tech_name || 'N/A'}</td></tr>
          <tr><td><strong>Customer:</strong></td><td>${data.sig_cust_name || 'N/A'}</td></tr>
          <tr><td><strong>Date:</strong></td><td>${data.sig_date || 'N/A'}</td></tr>
        </table>
      `;

      // Signatures images (if available)
      if (data.sigTech || data.sigCust) {
        html += `<div class="sig-display-pair">`;
        if (data.sigTech) {
          html += `
            <div class="sig-display-block">
              <div class="sig-label">Technician Signature</div>
              <img src="${escapeHtml(data.sigTech)}" alt="Tech sig" style="max-width: 100%; border: 1px solid #ddd;">
            </div>
          `;
        }
        if (data.sigCust) {
          html += `
            <div class="sig-display-block">
              <div class="sig-label">Customer Signature</div>
              <img src="${escapeHtml(data.sigCust)}" alt="Cust sig" style="max-width: 100%; border: 1px solid #ddd;">
            </div>
          `;
        }
        html += `</div>`;
      }

      // Files section (PDF + photos) — populated asynchronously below.
      html += `
        <h3 class="details-section-title">Report &amp; Photos</h3>
        <div id="details-files" class="details-files">
          <div class="files-loading">Loading files\u2026</div>
        </div>
      `;

      html += `</div>`;

      body.innerHTML = html;
      modal.hidden = false;

      loadFiles(id);
    } catch (err) {
      console.error('Details load failed:', err);
      showStatus(`Failed to load details: ${err.message}`, 'error');
    }
  }

  async function loadFiles(inspectionId) {
    const container = document.getElementById('details-files');
    if (!container) return;
    try {
      const res = await BatesAuth.authFetch(`${API_BASE}/inspections/${inspectionId}/files`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const { pdfUrl, photos } = await res.json();

      let html = '';
      html += `<div class="files-actions">`;
      if (pdfUrl) {
        html += `<a class="btn-primary btn-sm" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener">Open PDF Report</a>`;
      }
      if (photos && photos.length) {
        html += `<button type="button" class="btn-secondary btn-sm" id="download-zip-btn">Download All Photos (.zip)</button>`;
      }
      html += `</div>`;

      if (photos && photos.length) {
        html += `<div class="files-photo-grid">`;
        for (const p of photos) {
          html += `
            <a class="files-photo" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(p.name)}">
              <img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.name)}" loading="lazy">
            </a>
          `;
        }
        html += `</div>`;
      } else {
        html += `<p class="files-empty">No photos uploaded for this inspection.</p>`;
      }

      container.innerHTML = html;

      const zipBtn = document.getElementById('download-zip-btn');
      if (zipBtn) {
        zipBtn.addEventListener('click', () => downloadPhotosZip(inspectionId, zipBtn));
      }
    } catch (err) {
      console.error('Files load failed:', err);
      container.innerHTML = `<p class="files-error">Could not load files: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function downloadPhotosZip(inspectionId, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Building zip\u2026';
    try {
      const res = await BatesAuth.authFetch(`${API_BASE}/inspections/${inspectionId}/photos.zip`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(t || `Failed (${res.status})`);
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const m = /filename="([^"]+)"/.exec(disposition);
      const filename = m ? m[1] : `inspection-${inspectionId}-photos.zip`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Zip download failed', err);
      showStatus(`Zip download failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // Delete inspection
  async function deleteInspection(id) {
    showStatus('Deleting...', 'info');
    try {
      const response = await BatesAuth.authFetch(`${API_BASE}/inspections/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Delete failed');
      showStatus('Inspection deleted.', 'success');
      closeModal();
      await loadInspections();
    } catch (err) {
      console.error('Delete failed:', err);
      showStatus(`Delete failed: ${err.message}`, 'error');
    }
  }

  // Modal controls
  function closeModal() {
    const modal = document.getElementById('detailsModal');
    modal.hidden = true;
    currentDetailId = null;
  }

  // Filters
  function setupFilters() {
    const inputs = {
      'filter-customer': 'customer',
      'filter-job': 'job',
      'filter-date-start': 'dateStart',
      'filter-date-end': 'dateEnd'
    };

    Object.entries(inputs).forEach(([id, key]) => {
      const el = document.getElementById(id);
      el.addEventListener('input', (e) => {
        filterState[key] = e.target.value;
        renderInspections();
      });
    });
  }

  // Helpers
  function showLoading(show) {
    document.getElementById('loading').hidden = !show;
  }

  function showStatus(msg, kind = 'info') {
    const el = document.getElementById('status');
    el.hidden = false;
    el.className = `status ${kind}`;
    el.textContent = msg;
  }

  function ratingColor(rating) {
    if (rating === 'Safe' || rating === 'Good') return '#22c55e';
    if (rating === 'Risk' || rating === 'Fair') return '#f59e0b';
    if (rating === 'Hazard' || rating === 'Poor') return '#ef4444';
    return '#666';
  }

  // Shared quote-safe escaper from ui-dialogs.js (loaded just before this
  // script) — one implementation for every page instead of per-file copies.
  const escapeHtml = window.BatesUI.escapeHtml;

  // Init
  checkRole();
  setupFilters();
  loadInspections();

  // Refresh button (optional — only present on some layouts)
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadInspections);

  // Modal close buttons
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-close-btn2').addEventListener('click', closeModal);
  document.getElementById('modal-delete-btn').addEventListener('click', async () => {
    if (currentDetailId && await openConfirm({ title: 'Delete inspection?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true })) {
      deleteInspection(currentDetailId);
    }
  });

  // Close modal on overlay click
  document.querySelector('.modal-overlay').addEventListener('click', closeModal);

  // Keyboard ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
})();
