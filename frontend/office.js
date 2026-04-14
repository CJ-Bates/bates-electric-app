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
      const response = await fetch(`${API_BASE}/me`, {
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
    try {
      const response = await fetch(`${API_BASE}/inspections?status=submitted&limit=200`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to load inspections');
      const { inspections } = await response.json();
      allInspections = inspections || [];
      renderInspections();
      showLoading(false);
    } catch (err) {
      console.error('Load failed:', err);
      showStatus(`Failed to load inspections: ${err.message}`, 'error');
      showLoading(false);
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

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    container.innerHTML = filtered.map(insp => {
      const date = insp.job_date ? new Date(insp.job_date).toLocaleDateString() : 'N/A';
      const technicianId = insp.technician_id ? `Tech: ${insp.technician_id.substring(0, 8)}...` : 'Tech: Unknown';
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
              <p><strong>${technicianId}</strong></p>
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
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (confirm('Are you sure you want to delete this inspection? This cannot be undone.')) {
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
      const response = await fetch(`${API_BASE}/inspections/${id}`, {
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
          <tr><td><strong># Photos:</strong></td><td>${data.job_photos || 'N/A'}</td></tr>
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

      // Recommended services
      const checked = [];
      const upsellNames = [
        'up_panel', 'up_surge', 'up_breaker', 'up_gfci', 'up_afci', 'up_ev',
        'up_sub', 'up_circuit', 'up_smoke', 'up_co', 'up_alum', 'up_arc',
        'up_svc', 'up_gen', 'up_outdoor', 'up_covers', 'up_label', 'up_ground'
      ];
      upsellNames.forEach(n => {
        if (data[n]) checked.push(data[n]);
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

      html += `</div>`;

      body.innerHTML = html;
      modal.hidden = false;
    } catch (err) {
      console.error('Details load failed:', err);
      showStatus(`Failed to load details: ${err.message}`, 'error');
    }
  }

  // Delete inspection
  async function deleteInspection(id) {
    showStatus('Deleting...', 'info');
    try {
      const response = await fetch(`${API_BASE}/inspections/${id}`, {
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

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Init
  checkRole();
  setupFilters();
  loadInspections();

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', loadInspections);

  // Modal close buttons
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-close-btn2').addEventListener('click', closeModal);
  document.getElementById('modal-delete-btn').addEventListener('click', () => {
    if (currentDetailId && confirm('Delete this inspection?')) {
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
