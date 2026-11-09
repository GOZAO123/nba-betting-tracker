/* NBA Betting Tracker · Safety Update 33.1
   Only the public app shell is cached. Firebase, ESPN and OddsPapi are never cached.
   Navigations are network-first, with an offline fallback to the latest saved HTML.
*/
const APP_CACHE = 'nba-tracker-shell-v33-1';
const CACHE_PREFIX = 'nba-tracker-';
const SHELL_ASSETS = ['./index.html', './manifest.webmanifest', './icon.svg'];
const APP_SCOPE = new URL(self.registration.scope);
const SHELL_FALLBACK = new URL('./index.html', APP_SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // Do not install an app shell using a possibly stale browser HTTP cache.
    await cache.addAll(SHELL_ASSETS.map(path => new Request(
      new URL(path, APP_SCOPE).href, { cache: 'reload' }
    )));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== APP_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== APP_SCOPE.origin || !url.pathname.startsWith(APP_SCOPE.pathname)) return;

  const relativePath = url.pathname.slice(APP_SCOPE.pathname.length);
  const isNavigation = request.mode === 'navigate';
  const isShell = relativePath === '' || relativePath === 'index.html';
  const isAsset = relativePath === 'manifest.webmanifest' || relativePath === 'icon.svg';
  if (!isNavigation && !isShell && !isAsset) return;

  event.respondWith((async () => {
    const cacheKey = isNavigation || isShell
      ? SHELL_FALLBACK
      : new URL('./' + relativePath, APP_SCOPE).href;
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(APP_CACHE);
        await cache.put(cacheKey, response.clone());
      }
      return response;
    } catch (_) {
      // Only serve a cached shell when offline/network-failed.
      // Do not turn HTTP errors into an apparently successful stale app.
      const cache = await caches.open(APP_CACHE);
      return await cache.match(cacheKey) || Response.error();
    }
  })());
});
