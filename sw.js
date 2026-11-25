/**
 * Earlisthenic Progressive Web App Service Worker (v2.12.6)
 * 
 * Strategy:
 * - HTML Shell Navigation: Network-First (2.5s safety timeout, falls back to cache when offline)
 *   Guarantees immediate delivery of new deployments without trapping mobile users on stale iframes.
 * - Lossless Audio Masters (audio/*.flac): Cache-First
 * - Edge Dist Scripts & Manifest: Stale-While-Revalidate
 */

const CACHE_NAME_APP = 'earlisthenic-shell-v2.12.6';
const CACHE_NAME_AUDIO = 'earlisthenic-audio-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './audio/earlisthenic-catalog.json',
  './audio/earlisthenic-waveforms.json',
  './dist/earlisthenic-fir-processor.js',
  './dist/earlisthenic-visualizer-worker.js',
  './dist/earlisthenic-neural-worker.js',
  './modules/pwa/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME_APP).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME_APP && key !== CACHE_NAME_AUDIO) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Lossless Audio Files: Cache-First
  if (url.pathname.endsWith('.flac') || url.pathname.includes('/audio/')) {
    event.respondWith(
      caches.open(CACHE_NAME_AUDIO).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok && res.status === 200) {
            cache.put(req, res.clone());
          }
          return res;
        } catch (e) {
          return cached || new Response('Offline audio unavailable', { status: 503 });
        }
      })
    );
    return;
  }

  // 2. HTML Navigation Shell: Network-First with 2.5s Timeout Fallback
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME_APP);
        try {
          const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          const timeoutId = controller ? setTimeout(() => controller.abort(), 2500) : null;
          const fetchOpts = controller ? { signal: controller.signal } : {};
          const networkRes = await fetch(req, fetchOpts);
          if (timeoutId) clearTimeout(timeoutId);
          if (networkRes && networkRes.ok) {
            cache.put(req, networkRes.clone());
            return networkRes;
          }
        } catch (e) {}
        const cached = await cache.match(req);
        if (cached) return cached;
        return fetch(req);
      })()
    );
    return;
  }

  // 3. App code, scripts & modules: Stale-While-Revalidate
  if (req.method === 'GET' && (url.origin === location.origin || url.hostname.includes('github.io'))) {
    event.respondWith(
      caches.open(CACHE_NAME_APP).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req).then((networkRes) => {
          if (networkRes.ok) {
            cache.put(req, networkRes.clone());
          }
          return networkRes;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // 4. Default: Network fetch
  event.respondWith(fetch(req));
});
