/* BaysSystems Acquisition — hafif service worker.
   Uygulama kabuğu önbelleklenir; API istekleri HER ZAMAN ağdan gelir (sahte/eski metrik gösterilmez). */
const VERSION = 'bays-acq-v1';
const SHELL = ['/offline', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/webhooks') || url.pathname.startsWith('/internal')) return;
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline')));
  }
});
