/**
 * Earlisthenic Progressive Web App Service Worker
 * 
 * Strategy:
 * - Cache-First for lossless audio master tracks (audio/*.flac)
 * - Stale-While-Revalidate for app code, styles, and catalogs
 * - Network-First for dynamic training sessions and profile sync
 */

const CACHE_NAME_APP = 'earlisthenic-shell-v2.11.0';
const CACHE_NAME_AUDIO = 'earlisthenic-audio-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './audio/earlisthenic-catalog.json',
  './modules/audio/LoudnessMatcher.js',
  './modules/visualizer/SpectrumVisualizer.js',
  './modules/adaptive/JndEngine.js',
  './modules/storage/R2StorageClient.js',
  './modules/storage/SupabaseRepository.js',
  './dist/earlisthenic-visualizer-worker.js',
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

  // Audio files: Cache-First
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

  // App shell & modules: Stale-While-Revalidate
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

  // Default: Network fetch
  event.respondWith(fetch(req));
});
