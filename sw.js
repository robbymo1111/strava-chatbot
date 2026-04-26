'use strict';

const CACHE_VERSION = 'v2';
const CACHE_NAME    = `coach-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/chat.html',
  '/css/style.css',
  '/js/app.js',
  '/js/vdot.js',
  '/js/push.js',
  '/manifest.json',
  '/icon-192.png',
];

/* ── Install: pre-cache core files ─────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: purge old caches ─────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: cache-first for local assets ────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache API calls

  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

/* ── Push: show lock-screen notification ────────────────────────────────── */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(data.title || 'Coach', {
      body:               data.body  || '',
      icon:               '/icon-192.png',
      badge:              '/icon-192.png',
      data:               { url: data.url || '/chat.html' },
      requireInteraction: false,
      vibrate:            [100, 50, 100],
    })
  );
});

/* ── Notification click: focus or open the app ──────────────────────────── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/chat.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        // Re-focus an existing open window (prefer non-index pages)
        const existing = list.find(c => !new URL(c.url).pathname.match(/^\/?$/));
        if (existing) return existing.focus();
        return clients.openWindow(target);
      })
  );
});
