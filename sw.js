'use strict';

const CACHE_VERSION = 'v6';
const CACHE_NAME    = `coach-${CACHE_VERSION}`;

// Static assets that rarely change — cache-first is fine
const STATIC = [
  '/manifest.json',
  '/icon-192.png',
];

// App shell files — always fetch fresh; fall back to cache only when offline
const APP_SHELL = [
  '/',
  '/chat.html',
  '/css/style.css',
  '/js/app.js',
  '/js/vdot.js',
  '/js/push.js',
];

/* ── Install: pre-cache static assets only ──────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC))
      .then(() => self.skipWaiting())  // activate immediately, don't wait for old tabs
  );
});

/* ── Activate: purge all old caches + claim all clients immediately ─────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch strategy ─────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never intercept API calls

  const isAppShell = APP_SHELL.some(p => url.pathname === p || url.pathname === p + '/');
  const isStatic   = STATIC.some(p => url.pathname === p);

  if (isAppShell) {
    // Network-first: always try to get the latest, fall back to cache when offline
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else if (isStatic) {
    // Cache-first for icons / manifest
    event.respondWith(
      caches.match(event.request)
        .then(cached => cached || fetch(event.request))
    );
  }
  // All other requests (fonts, CDN scripts, etc.) go straight to network
});
