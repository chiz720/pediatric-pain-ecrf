/**
 * Versioned precache. The cache name carries the build, so a deploy cannot
 * leave a tablet running half of one version and half of another.
 *
 * A stale tablet still works and still syncs; its rows simply carry its old
 * app_version. That is deliberate — never break a working device mid-camp.
 */

const VERSION = '2026.09.22u-crf';
const CACHE = `ppp-ecrf-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './crf.css',
  './crf.js',
  './config.js',
  './manifest.webmanifest',
  './schema/params.json',
  './lib/params.js',
  './lib/age.js',
  './lib/clock.js',
  './lib/routing.js',
  './lib/studyNumber.js',
  './lib/scoring.js',
  './lib/outbox.js',
  './lib/store.js',
  './lib/sync.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache: 'reload' bypasses the browser's HTTP cache. Without it a deploy
      // can precache a stale file that the HTTP cache happened to be holding,
      // leaving a tablet on a new version running old schema or scoring code.
      return Promise.all(SHELL.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' }))
          .then(function (res) {
            if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
            return cache.put(url, res);
          });
      }));
    }).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;                    // submissions never cache
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;         // the endpoint is never cached

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background, but always answer from cache first: a
        // ward tablet on a weak signal must not wait for the network.
        fetch(request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
