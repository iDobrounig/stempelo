const CACHE_NAME = 'stempelo-v16';
const ASSETS = [
  './',
  'index.html',
  'index.css',
  'app.js',
  'syncService.js',
  'temporal-polyfill.js',
  'manifest.json',
  'assets/icon.png'
];

// Install Service Worker and cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching app shell and assets');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Service Worker and clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch assets from cache first, then fall back to network
self.addEventListener('fetch', (event) => {
  // Skip syncing request (API)
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch((err) => {
        console.error('Fetch failed, offline fallback:', err);
      });
    })
  );
});
