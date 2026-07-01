// Contacts page
// Team directory fetched from the authenticated API, live search filter, and
// copy-to-clipboard with toast feedback. The person data intentionally does
// NOT live in contacts.html 2014 it comes from GET /contacts-directory so it
// isn't readable in the public static HTML (see backend/lib/contactsDirectory.js).

const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:4000'
  : 'https://bates-electric-app.onrender.com';

document.addEventListener('DOMContentLoaded', function () {
  setupSearch();
  setupCopyButtons();
  loadDirectory();
});

// ---- Team directory (rendered client-side) ----

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ICON_MAIL_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const ICON_MAIL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const ICON_PHONE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
const ICON_COPY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function personCardHtml(p) {
  const searchBlob = [p.search, p.name, p.role, p.email, p.phone]
    .filter(Boolean).join(' ').toLowerCase();

  const metaRows = [];
  if (p.email) metaRows.push('<div class="contact-meta">' + ICON_MAIL_SM + '<span>' + escapeHtml(p.email) + '</span></div>');
  if (p.phone) metaRows.push('<div class="contact-meta">' + ICON_PHONE + '<span>' + escapeHtml(p.phone) + '</span></div>');

  const actions = [];
  if (p.email) {
    actions.push('<a class="contact-action" href="mailto:' + escapeHtml(p.email) + '" aria-label="Email ' + escapeHtml(p.name) + '">' + ICON_MAIL + '<span>Email</span></a>');
  }
  if (p.phone) {
    actions.push('<a class="contact-action" href="tel:' + escapeHtml(String(p.phone).replace(/\D/g, '')) + '" aria-label="Call ' + escapeHtml(p.name) + '">' + ICON_PHONE + '<span>Call</span></a>');
  }
  if (p.email) {
    actions.push('<button type="button" class="contact-action" data-copy="' + escapeHtml(p.email) + '" aria-label="Copy email address">' + ICON_COPY + '<span>Copy</span></button>');
  }

  return (
    '<article class="contact-card contact-card--detail" data-search="' + escapeHtml(searchBlob) + '">' +
      '<div class="contact-card-head">' +
        '<span class="contact-avatar" aria-hidden="true">' + escapeHtml(p.initials || (p.name || '?').charAt(0)) + '</span>' +
        '<div class="contact-body">' +
          '<div class="contact-name">' + escapeHtml(p.name) + '</div>' +
          '<div class="contact-role">' + escapeHtml(p.role || '') + '</div>' +
          metaRows.join('') +
        '</div>' +
      '</div>' +
      '<div class="contact-actions">' + actions.join('') + '</div>' +
    '</article>'
  );
}

function sectionHtml(section) {
  return (
    '<section class="contacts-section" data-group="' + escapeHtml(section.group || '') + '">' +
      '<h3 class="contacts-section-title">' + escapeHtml(section.title || '') + '</h3>' +
      (section.people || []).map(personCardHtml).join('') +
    '</section>'
  );
}

async function loadDirectory() {
  const mount = document.getElementById('contacts-directory');
  if (!mount) return;
  try {
    const res = await BatesAuth.authFetch(API_BASE + '/contacts-directory');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    mount.innerHTML = (data.directory || []).map(sectionHtml).join('');
    // Re-apply an in-progress search so the freshly rendered cards get filtered.
    const input = document.getElementById('contacts-filter');
    if (input && input.value) input.dispatchEvent(new Event('input'));
  } catch (err) {
    console.error('Directory load failed:', err);
    mount.innerHTML = '<p class="contacts-empty" style="display:block;">Couldn\u2019t load the team directory. Check your connection and refresh.</p>';
    showToast('Couldn\u2019t load the team directory');
  }
}

// ---- Search ----
// Sections are queried on every keystroke (not captured once) because the
// directory sections are rendered after load.

function setupSearch() {
  const input = document.getElementById('contacts-filter');
  const empty = document.getElementById('contacts-empty');
  if (!input) return;

  function applyFilter() {
    const q = input.value.trim().toLowerCase();
    let anyVisible = false;

    document.querySelectorAll('.contacts-section').forEach((section) => {
      const cards = Array.from(section.querySelectorAll('.contact-card'));
      let sectionMatch = false;

      cards.forEach((card) => {
        const haystack = ((card.dataset.search || '') + ' ' + card.textContent).toLowerCase();
        const match = !q || haystack.indexOf(q) !== -1;
        card.style.display = match ? '' : 'none';
        if (match) sectionMatch = true;
      });

      section.hidden = !sectionMatch;
      if (sectionMatch) anyVisible = true;
    });

    if (empty) empty.hidden = anyVisible;
  }

  input.addEventListener('input', applyFilter);
  input.addEventListener('search', applyFilter);
}

// ---- Copy to clipboard ----
// Delegated so buttons rendered after load (the directory cards) work too.

function setupCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    const value = btn.getAttribute('data-copy');
    if (!value) return;

    const ok = await copyToClipboard(value);
    if (ok) {
      flashCopied(btn);
      showToast('Copied ' + value);
    } else {
      showToast('Copy failed \u2014 long-press to copy manually');
    }
  });
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function flashCopied(btn) {
  const original = btn.querySelector('span') ? btn.querySelector('span').textContent : '';
  btn.classList.add('copied');
  if (original) {
    btn.querySelector('span').textContent = 'Copied';
  }
  setTimeout(() => {
    btn.classList.remove('copied');
    if (original) btn.querySelector('span').textContent = original;
  }, 1500);
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('contacts-toast');
  if (!toast) return;

  toast.textContent = message;
  toast.hidden = false;
  // Force reflow so the transition fires when we add .show
  void toast.offsetWidth;
  toast.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 220);
  }, 1800);
}

// Sign-out lives in shared-nav.js (topbar + drawer) 2014 the one shared code path
// that clears the real bates.auth.* keys. No page-local sign-out logic here.
