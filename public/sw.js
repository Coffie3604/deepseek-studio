/* DeepSeek Studio Service Worker */
const CACHE_NAME = 'deepseek-studio-v15';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/app.css',
  '/guide.html',
  '/manifest.json',
  '/icon-v2.svg',
  '/icon-192.png',
  '/icon-512.png'
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
  // Only GET requests are cacheable
  if (event.request.method !== 'GET') {
    return;
  }
  // Stale-while-revalidate for everything else
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      var network = fetch(event.request).then(function(response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(event.request, clone); });
        }
        return response;
      }).catch(function() {
        return cached || caches.match('/index.html');
      });
      return cached || network;
    })
  );
});

// Allow the page to trigger an immediate update
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Trim oversized caches so storage does not grow unbounded
var MAX_ENTRIES = 80;
function trimCache(name, maxItems) {
  caches.open(name).then(function(cache) {
    cache.keys().then(function(keys) {
      if (keys.length <= maxItems) return;
      return Promise.all(
        keys.slice(0, keys.length - maxItems).map(function(req) {
          return cache.delete(req);
        })
      );
    });
  });
}
self.addEventListener('fetch', function(event) {
  if (event.request.method === 'GET' && event.request.mode !== 'navigate') {
    event.waitUntil(trimCache(CACHE_NAME, MAX_ENTRIES));
  }
});