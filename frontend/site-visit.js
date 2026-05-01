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
    var files = svUploadedFiles[prompt.id] || [];
    var hasDone = files.length > 0;

    var div = document.createElement('div');
    div.className = 'sv-photo-prompt' + (hasDone ? ' has-file' : '');
    div.id = 'sv-prompt-' + prompt.id;

    var checkIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    var camIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1E3A6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

    div.innerHTML = '<div class="sv-prompt-icon' + (hasDone ? ' done' : '') + '">' + (hasDone ? checkIcon : camIcon) + '</div>'
      + '<div class="sv-prompt-text">'
      + '<div class="sv-prompt-label">' + prompt.label + '</div>'
      + '<div class="sv-prompt-sub">' + prompt.sub + '</div>'
      + (hasDone ? '<div class="sv-prompt-count">' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' uploaded</div>' : '')
      + '</div>'
      + '<div class="sv-prompt-actions">'
      + '<button class="sv-prompt-btn' + (hasDone ? ' done' : '') + '" onclick="svPickFile(\'' + prompt.id + '\')">' + (hasDone ? '+ More' : 'Add Photo') + '</button>'
      + '<div id="sv-prog-' + prompt.id + '" class="sv-upload-progress"><div class="sv-upload-bar" id="sv-bar-' + prompt.id + '"></div></div>'
      + '</div>';

    container.appendChild(div);
  });

  updateSVPhotoCount();
}

function updateSVPhotoCount() {
  var total = 0;
  Object.keys(svUploadedFiles).forEach(function(k) {
    total += svUploadedFiles[k].length;
  });
  total += svExtraFiles.length;
  var el = document.getElementById('sv-photo-count');
  if (el) el.textContent = total + ' uploaded';
}

function svPickFile(promptId) {
  var input = document.createElement('input');
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
  var id = 'extra-' + svExtraCount;
  var container = document.getElementById('sv-extra-uploads');

  var div = document.createElement('div');
  div.id = 'sv-extra-wrap-' + id;
  div.className = 'sv-photo-prompt';

  var camIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1E3A6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

  div.innerHTML = '<div class="sv-prompt-icon">' + camIcon + '</div>'
    + '<div class="sv-prompt-text">'
    + '<input class="sv-input sv-input--inline" type="text" id="sv-extra-label-' + id + '" placeholder="Label (optional)">'
    + '<div id="sv-extra-status-' + id + '" class="sv-extra-status"></div>'
    + '<div id="sv-prog-' + id + '" class="sv-upload-progress"><div class="sv-upload-bar" id="sv-bar-' + id + '"></div></div>'
    + '</div>'
    + '<button class="sv-prompt-btn" onclick="svPickExtraFile(\'' + id + '\')">Add</button>';

  container.appendChild(div);
}

function svPickExtraFile(extraId) {
  var input = document.createElement('input');
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
  var barId = promptId || extraId;
  var prog = document.getElementById('sv-prog-' + barId);
  var bar = document.getElementById('sv-bar-' + barId);

  if (prog) prog.style.display = 'block';
  if (bar) bar.style.width = '5%';

  var isVideo = file.type.startsWith('video/');
  var resourceType = isVideo ? 'video' : 'image';
  var uploadUrl = 'https://api.cloudinary.com/v1_1/' + SV_CLOUD_NAME + '/' + resourceType + '/upload';

  var customer = (document.getElementById('sv-customer').value || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  var date = document.getElementById('sv-date').value || new Date().toISOString().slice(0, 10);

  var fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', SV_UPLOAD_PRESET);

  var xhr = new XMLHttpRequest();

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
      var res = JSON.parse(xhr.responseText);
      var baseUrl = res.secure_url;

      if (!isVideo && baseUrl.indexOf('/upload/') > -1) {
        baseUrl = baseUrl.replace('/upload/', '/upload/a_exif,c_limit,w_2000/');
      }

      var fileObj = {url: baseUrl, publicId: res.public_id, type: isVideo ? 'video' : 'image', name: file.name};

      if (promptId) {
        if (!svUploadedFiles[promptId]) svUploadedFiles[promptId] = [];
        svUploadedFiles[promptId].push(fileObj);
        renderSVPrompts();
      } else if (extraId) {
        var labelEl = document.getElementById('sv-extra-label-' + extraId);
        fileObj.label = labelEl ? labelEl.value : '';
        svExtraFiles.push(fileObj);
        var statusEl = document.getElementById('sv-extra-status-' + extraId);
        var wrap = document.getElementById('sv-extra-wrap-' + extraId);
        if (statusEl) statusEl.textContent = fileObj.name + ' uploaded';
        if (wrap) wrap.classList.add('has-file');
        updateSVPhotoCount();
      }
    } else {
      var errMsg = 'Upload failed';
      try {
        var errObj = JSON.parse(xhr.responseText);
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
  var s = [];
  document.querySelectorAll('#sv-scope-tags input:checked').forEach(function(cb) {
    s.push(cb.value);
  });
  return s;
}

function svSetStatus(el, type, text) {
  el.className = 'sv-submit-status sv-status--' + type;
  el.textContent = text;
}

function svSubmit() {
  var btn = document.getElementById('sv-submit-btn');
  var statusEl = document.getElementById('sv-submit-status');

  var tech = (document.getElementById('sv-tech').value || '').trim();
  var customer = (document.getElementById('sv-customer').value || '').trim();
  var address = (document.getElementById('sv-address').value || '').trim();
  var date = document.getElementById('sv-date').value;

  if (!tech || !customer || !address || !date) {
    svSetStatus(statusEl, 'error', 'Please fill in: technician name, customer name, address, and date.');
    return;
  }

  try {
    localStorage.setItem('beTechName', tech);
  } catch (e) {}

  btn.disabled = true;
  btn.textContent = 'Sending...';

  svSetStatus(statusEl, 'info', 'Uploading files and sending to estimator...');

  var scopes = svGetScopes();
  var sub = {
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
    var saved = JSON.parse(localStorage.getItem(SV_STORAGE_KEY) || '[]');
    saved.unshift(sub);
    localStorage.setItem(SV_STORAGE_KEY, JSON.stringify(saved));
  } catch (e) {}

  var totalFiles = Object.keys(sub.photos).reduce(function(a, k) {
    return a + (sub.photos[k] || []).length;
  }, 0) + sub.extras.length;

  // Build email body
  var photoRows = '';
  SV_PHOTO_PROMPTS.forEach(function(p) {
    var files = sub.photos[p.id] || [];
    if (!files.length) return;

    photoRows += '<tr><td colspan="2" style="padding: 8px 10px 2px; font-size: 11px; font-weight: 700; color: #1a2b5e; text-transform: uppercase; letter-spacing: 0.5px; border-top: 1px solid #eef1f8;">' + p.label + '</td></tr><tr><td colspan="2" style="padding: 2px 10px 10px;">';

    files.forEach(function(f) {
      if (f.type === 'image') {
        var tUrl = f.url.indexOf('/upload/') > -1 ? f.url.replace('/upload/', '/upload/c_fill,w_200,h_150,a_exif/') : f.url;
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
      var tUrl2 = f.url.indexOf('/upload/') > -1 ? f.url.replace('/upload/', '/upload/c_fill,w_200,h_150,a_exif/') : f.url;
      photoRows += '<a href="' + f.url + '" target="_blank"><img src="' + tUrl2 + '" style="width: 100px; height: 75px; border-radius: 6px; margin: 2px; display: block;"></a>';
    } else {
      photoRows += '<a href="' + f.url + '" target="_blank" style="display: inline-block; padding: 4px 10px; background: #1E3A6E; color: #fff; border-radius: 6px; font-size: 11px; text-decoration: none;">&#9654; Video</a>';
    }

    photoRows += '</td></tr>';
  });

  var emailBody = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin: 0; padding: 20px 0; background: #e8ecf5; font-family: Helvetica, Arial, sans-serif;">'
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
      svSetStatus(statusEl, 'error', 'Email failed: ' + (err.text || 'unknown error') + '. Data saved locally.');
    }
  );
}

function svShowSuccess(btn, statusEl, totalFiles, offline) {
  btn.disabled = false;
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Submitted!';
  svSetStatus(statusEl, 'success', offline ? 'Saved locally. ' : 'Sent to ' + OFFICE_EMAIL + '! ' + totalFiles + ' file' + (totalFiles === 1 ? '' : 's') + ' uploaded to Cloudinary.');

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
    var el = document.getElementById(id);
    if (el) el.value = '';
  });

  ['sv-proptype', 'sv-amps', 'sv-complexity'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.selectedIndex = 0;
  });

  var fu = document.getElementById('sv-followup');
  if (fu) fu.value = 'No';

  var yr = document.getElementById('sv-year');
  if (yr) yr.value = '';

  var dt = document.getElementById('sv-date');
  if (dt) dt.value = new Date().toISOString().slice(0, 10);

  document.querySelectorAll('#sv-scope-tags input').forEach(function(cb) {
    cb.checked = false;
  });
  document.querySelectorAll('#sv-scope-tags .sv-chip').forEach(function(c) {
    c.classList.remove('checked');
  });

  var ex = document.getElementById('sv-extra-uploads');
  if (ex) ex.innerHTML = '';

  var sb = document.getElementById('sv-submit-btn');
  if (sb) {
    sb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit to Estimator';
  }

  var ss = document.getElementById('sv-submit-status');
  if (ss) {
    ss.className = 'sv-submit-status';
  }

  renderSVPrompts();
}

function svShowTab(tab) {
  var formContent = document.getElementById('form-tab-content');
  var dashContent = document.getElementById('dash-tab-content');
  var formBtn = document.getElementById('tab-form-btn');
  var dashBtn = document.getElementById('tab-dash-btn');

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
  var list = document.getElementById('sv-dash-list');
  var countEl = document.getElementById('sv-dash-count');

  if (!list) return;

  try {
    var saved = JSON.parse(localStorage.getItem(SV_STORAGE_KEY) || '[]');

    if (!saved.length) {
      countEl.textContent = 'No submissions yet';
      list.innerHTML = '<div class="sv-dash-empty">Submissions appear here after a site visit is submitted.</div>';
      return;
    }

    countEl.textContent = saved.length + ' submission' + (saved.length === 1 ? '' : 's');
    list.innerHTML = '';

    saved.forEach(function(sub) {
      var totalFiles = Object.keys(sub.photos || {}).reduce(function(a, k) {
        return a + (sub.photos[k] || []).length;
      }, 0) + (sub.extras || []).length;

      var allFiles = [];
      Object.keys(sub.photos || {}).forEach(function(k) {
        (sub.photos[k] || []).forEach(function(f) {
          allFiles.push(f);
        });
      });
      (sub.extras || []).forEach(function(f) {
        allFiles.push(f);
      });

      var thumbs = '';
      allFiles.slice(0, 5).forEach(function(f) {
        if (f.type === 'image') {
          thumbs += '<a href="' + f.url + '" target="_blank"><img class="sv-dash-thumb-img" src="' + f.url + '"></a>';
        } else {
          thumbs += '<a href="' + f.url + '" target="_blank" class="sv-dash-thumb-vid">&#9654; Vid</a>';
        }
      });

      if (allFiles.length > 5) {
        thumbs += '<div class="sv-dash-thumb-more">+' + (allFiles.length - 5) + '</div>';
      }

      var card = document.createElement('div');
      card.className = 'sv-dash-card';
      card.innerHTML = '<div class="sv-dash-card-head">'
        + '<div><div class="sv-dash-customer">' + sub.customer + '</div>'
        + '<div class="sv-dash-address">' + sub.address + '</div></div>'
        + '<div class="sv-dash-meta"><div class="sv-dash-date">' + sub.date + '</div><div class="sv-dash-tech">' + sub.tech + '</div></div>'
        + '</div>'
        + (sub.scopes && sub.scopes.length ? '<div class="sv-dash-scopes">' + (sub.scopes || []).join(' &bull; ') + '</div>' : '')
        + (thumbs ? '<div class="sv-dash-thumbs">' + thumbs + '</div>' : '')
        + '<div class="sv-dash-footer">'
        + '<div class="sv-dash-file-count">' + totalFiles + ' file' + (totalFiles === 1 ? '' : 's') + (sub.complexity ? ' &bull; ' + sub.complexity : '') + '</div>'
        + (sub.followup === 'Yes' ? '<span class="sv-dash-followup">Follow-up needed</span>' : '')
        + '</div>';

      list.appendChild(card);
    });
  } catch (e) {
    console.error('Error loading dashboard:', e);
    countEl.textContent = 'Error loading submissions';
  }
}
