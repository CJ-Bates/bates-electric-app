const CACHE = 'bates-shell-v10';
const ASSETS = [
  './',
  './index.html',
  './home.html',
  './inspection.html',
  './styles.css',
  './app.js',
  './home.js',
  './inspection.js',
  './inspection-fields.js',
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

// Network-first for the app shell (HTML/CSS/JS) so updates propagate immediately.
// Cache-first for everything else (images, fonts) for speed and offline support.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const isShell =
    request.mode === 'navigate' ||
    /\.(html|css|js)$/i.test(url.pathname);

  if (isShell) {
    // Network-first: always try fresh, fall back to cache when offline.
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request))
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
