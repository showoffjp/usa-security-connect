/*
 * USA Security Connect service worker.
 *
 * Deliberately small. It exists so the app can be installed to a phone's home
 * screen and so a lost signal shows a clear "No connection" page instead of
 * the browser's dinosaur. It never caches API responses - a clock-in, a
 * check-in or a post order must always be the live one - and it serves the
 * app itself from the network first, so a new deploy is picked up at once.
 */
const CACHE = 'usc-shell-v2';
const OFFLINE = ['/offline.html', '/icon-192.png', '/shield.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Page loads: the network, and the offline page when there is none.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }
  // The offline page's own image and icon, when offline.
  if (OFFLINE.includes(url.pathname)) {
    event.respondWith(fetch(request).catch(() => caches.match(url.pathname)));
  }
});
