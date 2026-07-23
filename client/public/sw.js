const CACHE_NAME = 'expert-safety-pwa-v2';
const MAX_CACHE_ENTRIES = 80;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Keeps the cache from growing without bound on mobile devices with limited storage —
// evicts oldest entries (Cache API preserves insertion order) once over the cap.
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Do not intercept API POST/PUT/DELETE requests in Service Worker fetch handler
  // API GET requests can use Network-First strategy with cache fallback
  if (url.pathname.startsWith('/api')) {
    if (event.request.method === 'GET') {
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const resClone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, resClone);
                trimCache(CACHE_NAME, MAX_CACHE_ENTRIES);
              });
            }
            return response;
          })
          .catch(() => caches.match(event.request))
      );
    }
    return;
  }

  if (event.request.method !== 'GET') return;

  // Stale-While-Revalidate for app assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse.ok) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
            trimCache(CACHE_NAME, MAX_CACHE_ENTRIES);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
