/**
 * Service worker for the Terse phone web app.
 *
 * WHAT IT IS FOR. Two things, and deliberately not a third:
 *   1. Making the app installable at all — iOS will not offer Add to Home
 *      Screen, and will not deliver Web Push, without a registered worker.
 *   2. Getting the SHELL on screen instantly, and at all, on a subway with no
 *      signal. The shell is HTML, CSS and the engine files; it is big (Three.js
 *      is most of it) and it changes rarely.
 *
 * WHAT IT DELIBERATELY DOES NOT CACHE: anything under /api. Every byte the app
 * shows — your agents, the roster, who is in the plaza — is a fact about RIGHT
 * NOW, and a stale one is worse than a spinner. The whole product is a live
 * view; caching it would be caching a lie.
 *
 * NETWORK-FIRST FOR NAVIGATIONS. The app shell is one HTML file that is also the
 * router, so a cache-first navigation would pin users to an old build until they
 * cleared Safari — with no update prompt available on iOS to tell them to. The
 * cached copy is the offline fallback, not the normal path.
 */
const VERSION = 'terse-phone-v1';
const SHELL = `${VERSION}-shell`;

/* Precached at install: the smallest set that renders SOMETHING useful offline.
   The wallpaper engines are NOT here — they are megabytes, they are only needed
   on one tab, and a failed install would take the whole worker down with it.
   They land in the cache the first time they are actually fetched. */
const PRECACHE = [
  '/m',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is all-or-nothing; one 404 would abort the install and leave the
    // app uninstallable. Failures here are not worth that.
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // Clerk, fonts, analytics
  if (url.pathname.startsWith('/api/')) return;         // never cache live data

  // Navigations: network first, cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('/m', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('/m')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: serve from cache, and refresh in the background so a shipped
  // fix reaches the next launch without ever blocking this one.
  if (/^\/(app-assets|icon-|manifest)/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await network) || Response.error();
    })());
  }
});

/* Web Push. iOS delivers this only to a web app installed on the Home Screen —
   never to a Safari tab — which is why the app asks for permission from the
   settings tab, after install, instead of on first load where it would be
   refused silently on most iPhones. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* non-JSON payload */ }
  const title = data.title || 'Terse';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'terse',
    data: { url: data.url || '/m' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/m';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focusing the open app beats opening a second copy of it.
    for (const c of all) {
      if (c.url.includes('/m') && 'focus' in c) { await c.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
