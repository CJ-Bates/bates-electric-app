// Site Visit Form
// Cloudinary and EmailJS integration for photo uploads and email submission

// Configuration
const SV_CLOUD_NAME = 'ddybnvayd';
const SV_UPLOAD_PRESET = 'bates_site_visits';
const SV_STORAGE_KEY = 'beSiteVisits';

const EMAILJS_SERVICE_ID = 'service_9o854p5';
const EMAILJS_TEMPLATE_ID = 'template_j94dma6';
const EMAILJS_PUBLIC_KEY = 'DeDPpeJ2O4A0B17_E';
const OFFICE_EMAIL = 'cjbates@bates-electric.com';

// Photo prompts
const SV_PHOTO_PROMPTS = [
  {id: 'main-panel', label: 'Main Electrical Panel', sub: 'Full panel door open, label visible, all breakers showing'},
  {id: 'panel-label', label: 'Panel Rating Label', sub: 'Close-up of the panel data/rating label inside the door'},
  {id: 'meter', label: 'Electric Meter', sub: 'Full meter socket and meter face, show service entry'},
  {id: 'service-entry', label: 'Service Entry / Weatherhead', sub: 'Where the utility wires connect to the building'},
  {id: 'panel-location', label: 'Panel Location Overview', sub: 'Wide shot showing panel location in the space'},
  {id: 'work-area', label: 'Proposed Work Area', sub: 'Where the new work will be installed'},
  {id: 'distance', label: 'Distance / Run Path', sub: 'Show the distance from panel to work area - walk the path'},
  {id: 'access', label: 'Access Points', sub: 'Attic hatch, crawlspace entry, walls that need to be opened'}
];

let svUploadedFiles = {};
let svExtraFiles = [];
let svExtraCount = 0;

document.addEventListener('DOMContentLoaded', function() {
  // Initialize EmailJS
  emailjs.init(EMAILJS_PUBLIC_KEY);

  // Set up sign out
  const signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', handleSignOut);
  }

  svInit();
});

function handleSignOut() {
  try {
    localStorage.removeItem('auth_token');
    sessionStorage.removeItem('auth_token');
  } catch (e) {}
  window.location.href = 'index.html';
}

function svInit() {
  const dateEl = document.getElementById('sv-date');
  if (dateEl && !dateEl.value) {
    dateEl.value = new Date().toISOString().slice(0, 10);
  }

  // Restore tech name from localStorage
  try {
    const tn = localStorage.getItem('beTechName');
    const techEl = document.getElementById('sv-tech');
    if (tn && techEl && !techEl.value) {
      techEl.value = tn;
    }
  } catch (e) {}

  renderSVPrompts();

  // Setup chip click handlers
  document.querySelectorAll('#sv-scope-tags .sv-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      const cb = chip.querySelector('input');
      if (cb) {
        cb.checked = !cb.checked;
        chip.classList.toggle('checked', cb.checked);
      }
    });
  });
}

function renderSVPrompts() {
  const container = document.getElementById('sv-photo-prompts');
  if (!container) return;
  container.innerHTML = '';

  SV_PHOTO_PROMPTS.forEach(function(prompt) {
    const files = svUploadedFiles[prompt.id] || [];
    const hasDone = files.length > 0;

    const div = document.createElement('div');
    div.className = 'sv-photo-prompt' + (hasDone ? ' has-file' : '');
    div.id = 'sv-prompt-' + prompt.id;

    const checkIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    const camIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1E3A6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

    div.innerHTML = '<div class="sv-prompt-icon' + (hasDone ? ' done' : '') + '">' + (hasDone ? checkIcon : camIcon) + '</div>'
      + '<div class="sv-prompt-text">'
      + '<div class="sv-prompt-label">' + prompt.label + '</div>'
      + '<div class="sv-prompt-sub">' + prompt.sub + '</div>'
      + (hasDone ? '<div class="sv-prompt-count">' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' uploaded</div>' : '')
      + '</div>'
      + '<div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0;">'
      + '<button class="sv-prompt-btn' + (hasDone ? ' done' : '') + '" onclick="svPickFile(\'' + prompt.id + '\')">' + (hasDone ? '+ More' : 'Add Photo') + '</button>'
      + '<div id="sv-prog-' + prompt.id + '" class="sv-upload-progress" style="width: 80px; display: none;"><div class="sv-upload-bar" id="sv-bar-' + prompt.id + '"></div></div>'
      + '</div>';

    container.appendChild(div);
  });

  updateSVPhotoCount();
}

function updateSVPhotoCount() {
  let total = 0;
  Object.keys(svUploadedFiles).forEach(function(k) {
    total += svUploadedFiles[k].length;
  });
  total += svExtraFiles.length;
  const el = document.getElementById('sv-photo-count');
  if (el) el.textContent = total + ' uploaded';
}

function svPickFile(promptId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.multiple = true;
  input.onchange = function() {
    if (!input.files || !input.files.length) return;
    Array.from(input.files).forEach(function(file) {
      svUploadFile(file, promptId, null);
    });
  };
  input.click();
}

function svAddExtraUpload() {
  svExtraCount++;
  const id = 'extra-' + svExtraCount;
  const container = document.getElementById('sv-extra-uploads');

  const div = document.createElement('div');
  div.id = 'sv-extra-wrap-' + id;
  div.className = 'sv-photo-prompt';

  const camIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1E3A6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

  div.innerHTML = '<div class="sv-prompt-icon">' + camIcon + '</div>'
    + '<div class="sv-prompt-text"><input class="sv-input" type="text" id="sv-extra-label-' + id + '" placeholder="Label (optional)" style="margin-bottom: 0; font-size: 13px;"><div id="sv-extra-status-' + id + '" style="font-size: 11px; color: rgba(15, 31, 61, 0.5); margin-top: 4px;"></div><div id="sv-prog-' + id + '" class="sv-upload-progress" style="display: none; margin-top: 4px;"><div class="sv-upload-bar" id="sv-bar-' + id + '"></div></div></div>'
    + '<button class="sv-prompt-btn" onclick="svPickExtraFile(\'' + id + '\')">Add</button>';

  container.appendChild(div);
}

function svPickExtraFile(extraId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.multiple = true;
  input.onchange = function() {
    if (!input.files || !input.files.length) return;
    Array.from(input.files).forEach(function(file) {
      svUploadFile(file, null, extraId);
    });
  };
  input.click();
}

function svUploadFile(file, promptId, extraId) {
  const barId = promptId || extraId;
  const prog = document.getElementById('sv-prog-' + barId);
  const bar = document.getElementById('sv-bar-' + barId);

  if (prog) prog.style.display = 'block';
  if (bar) bar.style.width = '5%';

  const isVideo = file.type.startsWith('video/');
  const resourceType = isVideo ? 'video' : 'image';
  const uploadUrl = 'https://api.cloudinary.com/v1_1/' + SV_CLOUD_NAME + '/' + resourceType + '/upload';

  const customer = (document.getElementById('sv-customer').value || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  const date = document.getElementById('sv-date').value || new Date().toISOString().slice(0, 10);

  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', SV_UPLOAD_PRESET);

  const xhr = new XMLHttpRequest();

  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable && bar) {
      bar.style.width = Math.round((e.loaded / e.total) * 90) + '%';
    }
  };

  xhr.onload = function() {
    if (bar) bar.style.width = '100%';
    setTimeout(function() {
      if (prog) prog.style.display = 'none';
    }, 800);

    if (xhr.status === 200 || xhr.status === 201) {
      const res = JSON.parse(xhr.responseText);
      let baseUrl = res.secure_url;

      if (!isVideo && baseUrl.indexOf('/upload/') > -1) {
        baseUrl = baseUrl.replace('/upload/', '/upload/a_exif,c_limit,w_2000/');
      }

      const fileObj = {url: baseUrl, publicId: res.public_id, type: isVideo ? 'video' : 'image', name: file.name};

      if (promptId) {
        if (!svUploadedFiles[promptId]) svUploadedFiles[promptId] = [];
        svUploadedFiles[promptId].push(fileObj);
        renderSVPrompts();
      } else if (extraId) {
        const labelEl = document.getElementById('sv-extra-label-' + extraId);
        fileObj.label = labelEl ? labelEl.value : '';
        svExtraFiles.push(fileObj);
        const statusEl = document.getElementById('sv-extra-status-' + extraId);
        const wrap = document.getElementById('sv-extra-wrap-' + extraId);
        if (statusEl) statusEl.textContent = fileObj.name + ' uploaded';
        if (wrap) wrap.classList.add('has-file');
        updateSVPhotoCount();
      }
    } else {
      let errMsg = 'Upload failed';
      try {
        const errObj = JSON.parse(xhr.responseText);
        errMsg = errObj.error && errObj.error.message ? errObj.error.message : xhr.responseText.slice(0, 200);
      } catch (e) {}
      alert('Upload failed: ' + errMsg);
      if (prog) prog.style.display = 'none';
    }
  };

  xhr.onerror = function() {
    alert('Upload error - check connection.');
    if (prog) prog.style.display = 'none';
  };

  xhr.open('POST', uploadUrl);
  xhr.send(fd);
}

function svGetScopes() {
  const s = [];
  document.querySelectorAll('#sv-scope-tags input:checked').forEach(function(cb) {
    s.push(cb.value);
  });
  return s;
}

function svSubmit() {
  const btn = document.getElementById('sv-submit-btn');
  const statusEl = document.getElementById('sv-submit-status');

  const tech = (document.getElementById('sv-tech').value || '').trim();
  const customer = (document.getElementById('sv-customer').value || '').trim();
  const address = (document.getElementById('sv-address').value || '').trim();
  const date = document.getElementById('sv-date').value;

  if (!tech || !customer || !address || !date) {
    statusEl.style.display = 'block';
    statusEl.style.background = 'rgba(220, 38, 38, 0.1)';
    statusEl.style.color = '#991B1B';
    statusEl.style.border = '0.5px solid rgba(220, 38, 38, 0.25)';
    statusEl.textContent = 'Please fill in: technician name, customer name, address, and date.';
    return;
  }

  try {
    localStorage.setItem('beTechName', tech);
  } catch (e) {}

  btn.disabled = true;
  btn.textContent = 'Sending...';

  statusEl.style.display = 'block';
  statusEl.style.background = 'rgba(30, 58, 110, 0.07)';
  statusEl.style.color = '#1E3A6E';
  statusEl.style.border = '0.5px solid rgba(30, 58, 110, 0.15)';
  statusEl.textContent = 'Uploading files and sending to estimator...';

  const scopes = svGetScopes();
  const sub = {
    id: Date.now(),
    date: date,
    tech: tech,
    customer: customer,
    phone: (document.getElementById('sv-phone').value || '').trim(),
    address: address,
    propType: document.getElementById('sv-proptype').value,
    year: document.getElementById('sv-year').value,
    scopes: scopes,
    scopeDesc: (document.getElementById('sv-scope-desc').value || '').trim(),
    amps: document.getElementById('sv-amps').value,
    panelBrand: (document.getElementById('sv-panel-brand').value || '').trim(),
    access: (document.getElementById('sv-access').value || '').trim(),
    notes: (document.getElementById('sv-notes').value || '').trim(),
    complexity: document.getElementById('sv-complexity').value,
    followup: document.getElementById('sv-followup').value,
    photos: JSON.parse(JSON.stringify(svUploadedFiles)),
    extras: svExtraFiles.slice(),
    submitted: new Date().toISOString()
  };

  try {
    const saved = JSON.parse(localStorage.getItem(SV_STORAGE_KEY) || '[]');
    saved.unshift(sub);
    localStorage.setItem(SV_STORAGE_KEY, JSON.stringify(saved));
  } catch (e) {}

  const totalFiles = Object.keys(sub.photos).reduce(function(a, k) {
    return a + (sub.photos[k] || []).length;
  }, 0) + sub.extras.length;

  // Build email body
  let photoRows = '';
  SV_PHOTO_PROMPTS.forEach(function(p) {
    const files = sub.photos[p.id] || [];
    if (!files.length) return;

    photoRows += '<tr><td colspan="2" style="padding: 8px 10px 2px; font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; border-top: 1px solid #eef1f8;">' + p.label + '</td></tr><tr><td colspan="2" style="padding: 2px 10px 10px;">';

    files.forEach(function(f) {
      if (f.type === 'image') {
        const tUrl = f.url.indexOf('/upload/') > -1 ? f.url.replace('/upload/', '/upload/c_fill,w_200,h_150,a_exif/') : f.url;
        photoRows += '<a href="' + f.url + '" target="_blank"><img src="' + tUrl + '" style="width: 100px; height: 75px; border-radius: 6px; margin: 2px; display: block;"></a> ';
      } else {
        photoRows += '<a href="' + f.url + '" target="_blank" style="display: inline-block; padding: 4px 10px; background: #1E3A6E; color: #fff; border-radius: 6px; font-size: 11px; text-decoration: none; margin: 2px;">&#9654; Video</a> ';
      }
    });

    photoRows += '</td></tr>';
  });

  sub.extras.forEach(function(f) {
    photoRows += '<tr><td colspan="2" style="padding: 8px 10px 2px; font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; border-top: 1px solid #eef1f8;">' + (f.label || 'Additional') + '</td></tr><tr><td colspan="2" style="padding: 2px 10px 10px;">';

    if (f.type === 'image') {
      const tUrl2 = f.url.indexOf('/upload/') > -1 ? f.url.replace('/upload/', '/upload/c_fill,w_200,h_150,a_exif/') : f.url;
      photoRows += '<a href="' + f.url + '" target="_blank"><img src="' + tUrl2 + '" style="width: 100px; height: 75px; border-radius: 6px; margin: 2px; display: block;"></a>';
    } else {
      photoRows += '<a href="' + f.url + '" target="_blank" style="display: inline-block; padding: 4px 10px; background: #1E3A6E; color: #fff; border-radius: 6px; font-size: 11px; text-decoration: none;">&#9654; Video</a>';
    }

    photoRows += '</td></tr>';
  });

  const emailBody = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin: 0; padding: 20px 0; background: #e8ecf5; font-family: Helvetica, Arial, sans-serif;">'
    + '<div style="max-width: 640px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);">'
    + '<div style="background: #1a2b5e; padding: 22px 24px;"><div style="font-size: 20px; font-weight: 900; color: #fff;">BATES ELECTRIC</div><div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-top: 3px; letter-spacing: 0.3px;">SITE VISIT &mdash; ESTIMATE REQUEST</div></div>'
    + '<div style="background: #f4f6fb; padding: 14px 24px; border-bottom: 2px solid #dce3f0;"><table width="100%" cellpadding="4" cellspacing="0"><tr>'
    + '<td><span style="font-size: 10px; color: #888; text-transform: uppercase; display: block;">Date</span><span style="font-size: 13px; color: #1a2b5e; font-weight: 700;">' + date + '</span></td>'
    + '<td><span style="font-size: 10px; color: #888; text-transform: uppercase; display: block;">Technician</span><span style="font-size: 13px; color: #1a2b5e; font-weight: 700;">' + tech + '</span></td>'
    + '<td><span style="font-size: 10px; color: #888; text-transform: uppercase; display: block;">Files</span><span style="font-size: 13px; color: #1a2b5e; font-weight: 700;">' + totalFiles + ' uploaded</span></td>'
    + '</tr></table></div>'
    + '<div style="padding: 16px 24px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888; width: 35%;">Customer</td><td style="padding: 5px 0; font-size: 13px; color: #1a2b5e; font-weight: 600;">' + customer + (sub.phone ? ' &nbsp; ' + sub.phone : '') + '</td></tr>'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888;">Address</td><td style="padding: 5px 0; font-size: 13px; color: #1a2b5e; font-weight: 600;">' + address + '</td></tr>'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888;">Property</td><td style="padding: 5px 0; font-size: 13px; color: #333;">' + (sub.propType || '--') + (sub.year ? ', built ' + sub.year : '') + '</td></tr>'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888;">Services</td><td style="padding: 5px 0; font-size: 13px; color: #333;">' + (scopes.join(', ') || '--') + '</td></tr>'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888;">Panel</td><td style="padding: 5px 0; font-size: 13px; color: #333;">' + (sub.amps || '--') + (sub.panelBrand ? ', ' + sub.panelBrand : '') + '</td></tr>'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888;">Complexity</td><td style="padding: 5px 0; font-size: 13px; color: #333;">' + (sub.complexity || '--') + '</td></tr>'
    + '<tr><td style="padding: 5px 0; font-size: 12px; color: #888;">Follow-up</td><td style="padding: 5px 0; font-size: 13px; color: #333;">' + sub.followup + '</td></tr>'
    + '</table>'
    + (sub.scopeDesc ? '<div style="margin-bottom: 12px;"><div style="font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; border-left: 3px solid #c8960c; padding-left: 8px;">Work Description</div><div style="font-size: 13px; color: #333; line-height: 1.6; background: #f8f9fc; padding: 10px 12px; border-radius: 6px;">' + sub.scopeDesc.replace(/\n/g, '<br>') + '</div></div>' : '')
    + (sub.access ? '<div style="margin-bottom: 12px;"><div style="font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; border-left: 3px solid #c8960c; padding-left: 8px;">Access &amp; Site Notes</div><div style="font-size: 13px; color: #333; line-height: 1.6; background: #f8f9fc; padding: 10px 12px; border-radius: 6px;">' + sub.access.replace(/\n/g, '<br>') + '</div></div>' : '')
    + (sub.notes ? '<div style="margin-bottom: 12px;"><div style="font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; border-left: 3px solid #c8960c; padding-left: 8px;">Tech Notes</div><div style="font-size: 13px; color: #333; line-height: 1.6; background: #f8f9fc; padding: 10px 12px; border-radius: 6px;">' + sub.notes.replace(/\n/g, '<br>') + '</div></div>' : '')
    + (photoRows ? '<div><div style="font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; border-left: 3px solid #c8960c; padding-left: 8px;">Photos &amp; Videos</div><table width="100%" style="border-collapse: collapse;">' + photoRows + '</table></div>' : '<div style="font-size: 13px; color: #888;">No photos uploaded.</div>')
    + '</div><div style="background: #0d1526; padding: 14px 20px; text-align: center;"><div style="font-size: 13px; font-weight: 700; color: #c8960c;">BATES ELECTRIC, INC.</div><div style="font-size: 11px; color: rgba(255, 255, 255, 0.45);">P.O. Box 100, Imperial, MO 63052 &nbsp;|&nbsp; 636.464.3939</div></div>'
    + '</div></body></html>';

  // Send via EmailJS
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    to_email: OFFICE_EMAIL,
    subject: 'Site Visit: ' + customer + ' - ' + address + ' (' + date + ')',
    tech_name: tech,
    customer_name: customer,
    date: date,
    job_num: '',
    address: address,
    html_report: emailBody
  }, EMAILJS_PUBLIC_KEY).then(
    function() {
      svShowSuccess(btn, statusEl, totalFiles, false);
    },
    function(err) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit to Estimator';
      statusEl.style.background = 'rgba(220, 38, 38, 0.1)';
      statusEl.style.color = '#991B1B';
      statusEl.style.border = '0.5px solid rgba(220, 38, 38, 0.2)';
      statusEl.textContent = 'Email failed: ' + (err.text || 'unknown error') + '. Data saved locally.';
    }
  );
}

function svShowSuccess(btn, statusEl, totalFiles, offline) {
  btn.disabled = false;
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Submitted!';
  statusEl.style.background = 'rgba(22, 163, 74, 0.1)';
  statusEl.style.color = '#15803D';
  statusEl.style.border = '0.5px solid rgba(22, 163, 74, 0.2)';
  statusEl.textContent = offline ? 'Saved locally. ' : 'Sent to ' + OFFICE_EMAIL + '! ' + totalFiles + ' file' + (totalFiles === 1 ? '' : 's') + ' uploaded to Cloudinary.';

  setTimeout(function() {
    svResetForm();
    svShowTab('dash');
  }, 2500);
}

function svResetForm() {
  svUploadedFiles = {};
  svExtraFiles = [];
  svExtraCount = 0;

  ['sv-customer', 'sv-phone', 'sv-address', 'sv-scope-desc', 'sv-panel-brand', 'sv-access', 'sv-notes'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  ['sv-proptype', 'sv-amps', 'sv-complexity'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.selectedIndex = 0;
  });

  const fu = document.getElementById('sv-followup');
  if (fu) fu.value = 'No';

  const yr = document.getElementById('sv-year');
  if (yr) yr.value = '';

  const dt = document.getElementById('sv-date');
  if (dt) dt.value = new Date().toISOString().slice(0, 10);

  document.querySelectorAll('#sv-scope-tags input').forEach(function(cb) {
    cb.checked = false;
  });
  document.querySelectorAll('#sv-scope-tags .sv-chip').forEach(function(c) {
    c.classList.remove('checked');
  });

  const ex = document.getElementById('sv-extra-uploads');
  if (ex) ex.innerHTML = '';

  const sb = document.getElementById('sv-submit-btn');
  if (sb) {
    sb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit to Estimator';
  }

  const ss = document.getElementById('sv-submit-status');
  if (ss) ss.style.display = 'none';

  renderSVPrompts();
}

function svShowTab(tab) {
  const formContent = document.getElementById('form-tab-content');
  const dashContent = document.getElementById('dash-tab-content');
  const formBtn = document.getElementById('tab-form-btn');
  const dashBtn = document.getElementById('tab-dash-btn');

  if (tab === 'form') {
    formContent.style.display = 'block';
    dashContent.style.display = 'none';
    formBtn.classList.add('active');
    dashBtn.classList.remove('active');
  } else {
    formContent.style.display = 'none';
    dashContent.style.display = 'block';
    dashBtn.classList.add('active');
    formBtn.classList.remove('active');
    svLoadDashboard();
  }
}

function svLoadDashboard() {
  const list = document.getElementById('sv-dash-list');
  const countEl = document.getElementById('sv-dash-count');

  if (!list) return;

  try {
    const saved = JSON.parse(localStorage.getItem(SV_STORAGE_KEY) || '[]');

    if (!saved.length) {
      countEl.textContent = 'No submissions yet';
      list.innerHTML = '<div style="text-align: center; padding: 40px 20px; color: rgba(15, 31, 61, 0.45); font-size: 14px;">Submissions appear here after a site visit is submitted.</div>';
      return;
    }

    countEl.textContent = saved.length + ' submission' + (saved.length === 1 ? '' : 's');
    list.innerHTML = '';

    saved.forEach(function(sub) {
      const totalFiles = Object.keys(sub.photos || {}).reduce(function(a, k) {
        return a + (sub.photos[k] || []).length;
      }, 0) + (sub.extras || []).length;

      const allFiles = [];
      Object.keys(sub.photos || {}).forEach(function(k) {
        (sub.photos[k] || []).forEach(function(f) {
          allFiles.push(f);
        });
      });
      (sub.extras || []).forEach(function(f) {
        allFiles.push(f);
      });

      let thumbs = '';
      allFiles.slice(0, 5).forEach(function(f) {
        if (f.type === 'image') {
          thumbs += '<a href="' + f.url + '" target="_blank"><img src="' + f.url + '" style="width: 56px; height: 46px; object-fit: cover; border-radius: 8px;"></a>';
        } else {
          thumbs += '<a href="' + f.url + '" target="_blank" style="width: 56px; height: 46px; background: #1E3A6E; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: 600; text-decoration: none;">&#9654; Vid</a>';
        }
      });

      if (allFiles.length > 5) {
        thumbs += '<div style="width: 56px; height: 46px; background: rgba(30, 58, 110, 0.08); border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: rgba(15, 31, 61, 0.55); font-weight: 600;">+' + (allFiles.length - 5) + '</div>';
      }

      const card = document.createElement('div');
      card.className = 'sv-dash-card';
      card.innerHTML = '<div style="display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px;">'
        + '<div><div style="font-size: 15px; font-weight: 700; color: var(--ink-900); letter-spacing: -0.2px;">' + sub.customer + '</div>'
        + '<div style="font-size: 12px; color: rgba(15, 31, 61, 0.55); margin-top: 1px;">' + sub.address + '</div></div>'
        + '<div style="text-align: right; flex-shrink: 0; margin-left: 12px;"><div style="font-size: 12px; font-weight: 600; color: rgba(15, 31, 61, 0.5);">' + sub.date + '</div><div style="font-size: 11px; color: rgba(15, 31, 61, 0.4); margin-top: 1px;">' + sub.tech + '</div></div>'
        + '</div>'
        + (sub.scopes && sub.scopes.length ? '<div style="font-size: 12px; color: rgba(15, 31, 61, 0.6); margin-bottom: 8px;">' + (sub.scopes || []).join(' &bull; ') + '</div>' : '')
        + (thumbs ? '<div style="display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; align-items: center;">' + thumbs + '</div>' : '')
        + '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">'
        + '<div style="font-size: 11px; color: rgba(15, 31, 61, 0.45);">' + totalFiles + ' file' + (totalFiles === 1 ? '' : 's') + (sub.complexity ? ' &bull; ' + sub.complexity : '') + '</div>'
        + (sub.followup === 'Yes' ? '<span style="background: rgba(202, 138, 4, 0.12); border: 0.5px solid rgba(202, 138, 4, 0.3); color: #92400E; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;">Follow-up needed</span>' : '')
        + '</div>';

      list.appendChild(card);
    });
  } catch (e) {
    console.error('Error loading dashboard:', e);
    countEl.textContent = 'Error loading submissions';
  }
}
