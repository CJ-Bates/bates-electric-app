// Contacts page
// Live search filter + copy-to-clipboard with toast feedback.

document.addEventListener('DOMContentLoaded', function () {
  setupSearch();
  setupCopyButtons();

  const signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', handleSignOut);
  }
});

function setupSearch() {
  const input = document.getElementById('contacts-filter');
  const empty = document.getElementById('contacts-empty');
  if (!input) return;

  const sections = Array.from(document.querySelectorAll('.contacts-section'));

  function applyFilter() {
    const q = input.value.trim().toLowerCase();
    let anyVisible = false;

    sections.forEach((section) => {
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

function setupCopyButtons() {
  const buttons = document.querySelectorAll('[data-copy]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const value = btn.getAttribute('data-copy');
      if (!value) return;

      const ok = await copyToClipboard(value);
      if (ok) {
        flashCopied(btn);
        showToast('Copied ' + value);
      } else {
        showToast('Copy failed — long-press to copy manually');
      }
    });
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

function handleSignOut() {
  try {
    localStorage.removeItem('auth_token');
    sessionStorage.removeItem('auth_token');
  } catch (e) {}
  window.location.href = 'index.html';
}
