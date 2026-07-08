const CACHE = 'bates-shell-v114';
const ASSETS = [
  './',
  './arrival-windows.js',
  './ui-dialogs.js',
  './ui-dialogs.css',
  './photo-lightbox.js',
  './tokens.css',
  './components.css',
  './icons.js',
  './index.html',
  './home.html',
  './tech.html',
  './tech.js',
  './inspection.html',
  './office.html',
  './generator-care.html',
  './generator-care.js',
  './accounting.html',
  './accounting.js',
  './members.html',
  './members.js',
  './metrics.html',
  './metrics.js',
  './settings.html',
  './documents.html',
  './safety-manual.html',
  './sds-sheets.html',
  './contacts.html',
  './contacts.js',
  './site-visit.html',
  './site-visit.js',
  './pdf-viewer.html',
  './reset-password.html',
  './app.css',
  './app.js',
  './home.js',
  './inspection.js',
  './inspection-fields.js',
  './office.js',
  './settings.js',
  './reset-password.js',
  './shared-nav.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Clean URLs: Netlify rewrites extensionless paths (/contacts) to their .html
// files (frontend/_redirects), so the SW normalizes every page path to its
// .html canonical form for cache keys. /contacts and /contacts.html hit the
// SAME cache entry; ASSETS stays .html-canonical and the offline shell keeps
// working no matter which URL form was navigated to.
function canonicalPath(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p !== '/' && /^\/[a-z0-9-]+$/i.test(p) ? p + '.html' : p;
}

// Network-first for the app shell (HTML/CSS/JS) so updates propagate immediately.
// Cache-first for everything else (images, fonts) for speed and offline support.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const path = canonicalPath(url.pathname);

  // Customer portal (my.html / my.js, incl. the /my pretty URL) is NOT part
  // of the staff PWA shell: customers shouldn't get the staff app cached on
  // their phones, and staff caches shouldn't serve stale portal code.
  // Network-only — no caching.
  if (/^\/my\.(html|js)$/i.test(path)) return;

  // Cache key = the .html canonical URL; network fetch keeps the original
  // request so Netlify's rewrite handles the pretty form.
  const cacheKey = path === url.pathname ? request : url.origin + path;

  const isShell =
    request.mode === 'navigate' ||
    /\.(html|css|js)$/i.test(path);

  if (isShell) {
    // Network-first: always try fresh, fall back to cache when offline.
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Cache-first for static assets.
  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      });
    })
  );
});
