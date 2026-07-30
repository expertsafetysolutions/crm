// Bumped to v6: v5 served index.html stale-while-revalidate, so after a deploy the browser ran the
// PREVIOUS shell — which points at the previous content-hashed bundles — and only picked up the new
// build on a second reload. Installed PWAs often never got that second reload, so a deploy could
// stay invisible on a phone indefinitely. Navigations are now network-first (see below); this bump
// evicts the shells cached under the old strategy.
//
// Bumped to v7 alongside the new-device verification work. Browsers holding a v6 shell were still
// running the pre-OTP login code: the server answered 202 "code required" and that old bundle had
// no branch for it, so it read the body as a success, found no token, and threw — which unmounted
// the app and closed the tab. Any change to the login/auth flow must bump this, or existing
// installs keep the old client against a new server.
const CACHE_NAME = 'expert-safety-pwa-v7';
const MAX_CACHE_ENTRIES = 80;

// Uploaded media lives in its own cache so large immutable images can't evict dynamic API
// responses, and so it survives an app-shell version bump (the URLs are content-addressed).
const MEDIA_CACHE_NAME = 'expert-safety-media-v1';
const MAX_MEDIA_CACHE_ENTRIES = 60;

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
  // Old caches are dropped BEFORE any client is claimed, so a page that gets taken over can never
  // be served a half-deleted cache.
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== MEDIA_CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      // claim() only after the cleanup resolves. It used to run synchronously alongside the
      // waitUntil above, so on a CACHE_NAME bump the new worker seized already-open tabs while
      // their old bundle was still executing. If that happened during a login — which itself
      // navigates — the tab was being reloaded from two directions at once and Chrome discarded
      // it, which is what looked like "the tab closes when I click Sign In".
      .then(() => self.clients.claim())
  );
});

// Vite's dev server rewrites module URLs whenever it re-optimises dependencies. Caching those
// responses makes the SW serve stale module URLs that no longer exist, which surfaces as
// "504 (Outdated Optimize Dep)" plus a blank page until the cache is cleared by hand. Dev traffic
// is therefore passed straight through, untouched. Production builds emit content-hashed
// /assets/* filenames and are unaffected.
const DEV_PASSTHROUGH = /^\/(@vite|@react-refresh|@id|@fs|src\/|node_modules\/)/;

// On the Vite dev server the SW has nothing useful to offer: there are no content-hashed bundles
// to cache, HMR pushes its own updates, and an intercepted navigation just serves a shell that
// references module URLs Vite may have already rewritten. Passing dev traffic through entirely
// also means a CACHE_NAME bump cannot disturb a tab that is open on localhost.
function isDevHost() {
  return self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
}

function isDevRequest(url) {
  return DEV_PASSTHROUGH.test(url.pathname) || url.search.includes('import&');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept cross-origin requests, anything on the dev server, or Vite's module graph.
  if (url.origin !== self.location.origin || isDevHost() || isDevRequest(url)) return;

  // Uploaded media (/api/media/:id) is immutable — a re-upload always mints a new ID — so it is
  // served cache-first rather than network-first. This keeps product photos available offline and
  // avoids a revalidation round-trip per image on every list render.
  if (url.pathname.startsWith('/api/media/')) {
    if (event.request.method === 'GET') {
      event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
          if (response.ok) {
            const resClone = response.clone();
            caches.open(MEDIA_CACHE_NAME).then((cache) => {
              cache.put(event.request, resClone);
              trimCache(MEDIA_CACHE_NAME, MAX_MEDIA_CACHE_ENTRIES);
            });
          }
          return response;
        }))
      );
    }
    return;
  }

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

  // ---- APP SHELL: network-first ----
  //
  // index.html names the content-hashed bundles for one specific build, so serving it from cache
  // pins the whole app to that build. Stale-while-revalidate meant a deploy needed two reloads to
  // appear, and an installed PWA that is never fully reloaded could stay on an old version for
  // days. The shell is small, so fetching it fresh costs little; the cache remains as the offline
  // fallback, which is the case it actually exists for.
  //
  // Hashed assets below stay cache-first and are unaffected: their URL changes whenever their
  // content does, so a cached copy can never be stale.
  const isNavigation = event.request.mode === 'navigate'
    || (event.request.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const resClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return response;
        })
        // Offline: fall back to this request, then to the shell, so a deep link still opens the app.
        .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // Stale-While-Revalidate for app assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse.ok) {
          // Clone SYNCHRONOUSLY, before the response is returned and its body consumed by the
          // page. Cloning inside the caches.open() callback runs a microtask too late and throws
          // "Failed to execute 'clone' on 'Response': Response body is already used".
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, resClone);
            trimCache(CACHE_NAME, MAX_CACHE_ENTRIES);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Expert Safety Solutions', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Expert Safety Solutions';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
