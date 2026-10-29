/* Hafeez Helfer service worker: caches the app shell so the app opens offline.
   It does NOT intercept cross-origin requests (Quran data API, audio hosts):
   Quran data is cached in IndexedDB by the app, and audio is cached only on explicit request. */
const CACHE = 'hafeez-shell-__BUILD_ID__';
const SHELL = __SHELL_FILES__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hafeez-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first for fresh builds, cache as offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && !url.pathname.includes('/data/')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
