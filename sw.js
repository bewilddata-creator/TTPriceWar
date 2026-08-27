// Service worker for Price Scout. Its whole job is: the app must OPEN with no signal at all,
// and it must never serve a stale price silently — those two goals pull in opposite directions,
// so every rule below exists to keep the app shell offline-safe while the API stays live.

// Bump this (e.g. 'pricescout-v2') when the PRECACHE list itself changes — that is what makes
// activate() drop the old cache. It is NOT required for ordinary deploys: cacheFirst() refreshes
// each entry in the background, so a phone serves the previous shell once and picks up the new
// one on the load after. Bumping simply makes that switch immediate instead of one load late.
const CACHE = 'pricescout-v1';

// The app shell: everything needed to open the app and use the scanner with zero network.
const PRECACHE = [
  './',
  './index.html',
  './core.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      // Activate this worker immediately rather than waiting for old tabs to close —
      // a shop visit is short, there is no time for the usual two-tab-refresh dance.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/**
 * Cache-first with a background refresh: serve the cached copy immediately if there is one
 * (so the UI never waits on the network for the shell or the scanner library), and update the
 * cache from the network in the background so the next load picks up whatever changed. If
 * there is no cached copy, fall through to the network and cache a successful response.
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const network = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    // Deliberately not awaited: the caller gets the cached response now and the refresh
    // lands whenever it lands. `network` already swallows its own errors.
    return cached;
  }

  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('no cache and network failed');
}

self.addEventListener('fetch', event => {
  const { request } = event;

  // POSTs (price saves) must never be cached or replayed by this worker — the app's own
  // outbox already owns retry logic, and a cached POST response would be actively wrong.
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // The Apps Script API must always be live: caching a price lookup would let a phone show
  // yesterday's prices as if they were current, which is worse than showing nothing.
  if (url.origin === 'https://script.google.com') return;

  const isSameOrigin = url.origin === self.location.origin;
  // The scanner library is the one third-party asset the app cannot function without offline,
  // so it is the one exception to "other origins fall through to the network".
  const isQrLib = url.origin === 'https://cdnjs.cloudflare.com';
  if (!isSameOrigin && !isQrLib) return;

  event.respondWith(
    cacheFirst(request).catch(async () => {
      // Offline with nothing cached for this exact request. The one case that matters is a
      // page navigation: hand back the cached app shell so the app still opens with zero
      // signal, instead of the browser's own "no internet" page.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      // Never let the fetch handler reject — an unhandled rejection here would surface as a
      // broken request in the page with no fallback at all.
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
