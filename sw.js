const CACHE = 'savdo-v6';
const SHELL = ['./', './index.html', './manifest.webmanifest'];
const NEVER_CACHE = ['/data/listings.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // let CDN/fonts pass through
  // listings data: always fresh from network, offline fallback to last copy
  if (NEVER_CACHE.some((p) => url.pathname.includes(p))) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // app shell: network-first (users always get the latest build), offline fallback
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
