/* DeepSeek Studio Service Worker */
const CACHE_NAME = 'deepseek-studio-v4';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/app.css',
  '/guide.html',
  '/manifest.json',
  '/icon-v2.svg'
];

self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE_URLS).catch(function() {});
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  // Never intercept API calls (localhost backend)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/pty')) {
    return;
  }
  // Network-first for HTML, cache-first for assets
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match('/');
      })
    );
    return;
  }
  // Stale-while-revalidate for everything else
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      var network = fetch(event.request).then(function(response) {
        if (response.ok && event.request.method === 'GET') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(event.request, clone); });
        }
        return response;
      }).catch(function() { return cached; });
      return cached || network;
    })
  );
});