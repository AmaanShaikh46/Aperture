/**
 * APERTURE - Service Worker
 * Caches only the public application shell/assets.
 * Does NOT cache private messages or authenticated data.
 */

const CACHE_NAME = 'aperture-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/app.html',
  '/css/bootstrap-overrides.css',
  '/css/app.css',
  '/css/chat.css',
  '/css/calls.css',
  '/css/assist.css',
  '/css/responsive.css',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, WebSocket, or authenticated data.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/ws/')) {
    return;
  }

  // Only handle GET requests for the app shell.
  if (event.request.method !== 'GET') return;

  // Cache-first for shell assets, network fallback.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache same-origin successful responses.
        if (url.origin === self.location.origin && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests.
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
