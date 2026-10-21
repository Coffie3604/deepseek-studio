const CACHE_NAME = 'deepseek-studio-v13';
const PRECACHE_URLS = [
  '/', '/index.html', '/app.css', '/manifest.json', '/icon-v2.svg',
  '/js/boot.js',
  '/js/core/state.js', '/js/core/bus.js', '/js/core/api.js',
  '/js/core/ui.js', '/js/core/lifecycle.js',
  '/js/features/chat.js', '/js/features/editor.js',
  '/js/features/files.js', '/js/features/git.js',
  '/js/features/settings.js', '/js/features/terminal.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/pty')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }
  // Code assets must be network-first so a deploy is picked up immediately;
  // stale-while-revalidate here served old modules after every update.
  const isCode = /\.(?:js|css|html)$/.test(url.pathname);
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return isCode ? network.catch(() => cached) : (cached || network);
    })
  );
});