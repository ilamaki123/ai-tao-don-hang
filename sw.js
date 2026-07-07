const CACHE_NAME = 'ai-basso-v73';
const STATIC_ASSETS = [
  'login.html',
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: 'no-store' forces the browser HTTP layer to fetch fresh,
      // so the SW never caches a stale copy from Safari's disk cache.
      Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url, { cache: 'no-store' })
            .then((res) => res.ok ? cache.put(url, res) : null)
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.includes('/api/')) return;

  // Navigation requests (HTML documents): always bypass HTTP cache, update SW cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request) || caches.match('index.html'))
    );
    return;
  }

  // Static assets (JS/CSS/images): network-first, fall back to cache when offline
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Allow the page to request an immediate update: navigator.serviceWorker.controller.postMessage('SKIP_WAITING')
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
