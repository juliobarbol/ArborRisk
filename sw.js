//  sw.js - Service Worker - ArborRisk (Gestion de Riesgo Biomecanico)
//  Estrategia (robusta ante actualizaciones):
//   - Navegaciones (abrir la app): NETWORK-FIRST con timeout y fallback
//     a cache. Al abrir, siempre intentamos traer la version nueva desde
//     la red; si no hay senal (o tarda), servimos la cacheada. Asi la app
//     instalada NUNCA queda pegada a una version vieja o rota.
//   - Resto de recursos del mismo origen: cache-first + revalidacion en
//     segundo plano.
//   - Recursos CROSS-ORIGIN que necesita la app para funcionar offline:
//       * Libs de cdnjs (jsPDF, Leaflet, markercluster, QR): cache-first.
//       * Fuentes de Google (googleapis + gstatic): cache-first.
//       * Tiles de OpenStreetMap: cache-first con TOPE (solo los ya
//         vistos quedan disponibles offline; no se puede cachear el mundo).
//     El resto de lo cross-origin pasa directo a la red.
//   - Nunca cacheamos respuestas redirigidas ni != 200 (mismo origen);
//     para cross-origin aceptamos tambien respuestas opacas (no-cors).
//
//  Para forzar actualizacion tras un deploy: subir el CACHE_VERSION.

const CACHE_VERSION = 'arborrisk-v4';
const RUNTIME_CACHE = CACHE_VERSION + '-cdn';    // libs + fuentes
const TILE_CACHE    = CACHE_VERSION + '-tiles';  // tiles OSM (con tope)
const CURRENT_CACHES = [CACHE_VERSION, RUNTIME_CACHE, TILE_CACHE];

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

// Hosts cross-origin que cacheamos para offline (cache-first).
const CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];
// Tiles del mapa: cache-first con tope (FIFO).
const TILE_HOST_RE = /(^|\.)tile\.openstreetmap\.org$/;
const TILE_MAX = 800;

// -- Install: precachear el app shell (resiliente) ------------
// Si un recurso puntual falla (red intermitente durante el deploy), NO
// abortamos toda la instalacion: cacheamos lo que se pueda y seguimos.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

// -- Activate: limpiar caches viejos y tomar control ----------
// Mantiene las 3 caches de la version actual; borra las de versiones
// anteriores (incluyendo libs y tiles viejos).
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !CURRENT_CACHES.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// -- Helper: cachear solo respuestas "sanas" (mismo origen) ---
// 200, del mismo origen y NO redirigidas. Cachear una respuesta
// redirigida rompe las navegaciones futuras (no se pueden servir).
function cachePut(req, res) {
  if (res && res.status === 200 && !res.redirected) {
    const copy = res.clone();
    caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

// -- Helper: fetch con timeout --------------------------------
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(
      (r) => { clearTimeout(t); resolve(r); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// -- Helper: buscar el documento en cache (varios fallbacks) --
function matchAppShell(req) {
  return caches.match(req)
    .then((r) => r || caches.match('./index.html'))
    .then((r) => r || caches.match('./'))
    .then((r) => r || caches.match(new Request('index.html')));
}

// -- Helper: cache-first cross-origin (libs y fuentes) --------
// Acepta respuestas 200 y opacas (no-cors). Si no hay red ni cache,
// devuelve un error de red (la app degrada sola: PDF/QR/mapa avisan).
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.status === 200 || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    return Response.error();
  }
}

// -- Helper: cache-first con tope (tiles del mapa) ------------
async function cacheFirstCapped(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.status === 200 || res.type === 'opaque')) {
      await cache.put(req, res.clone());
      trimCache(cacheName, max);
    }
    return res;
  } catch (e) {
    return Response.error();
  }
}

// -- Helper: recortar una cache a 'max' entradas (FIFO) -------
async function trimCache(cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const excess = keys.length - max;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  } catch (e) { /* noop */ }
}

// -- Fetch ----------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // --- Cross-origin: libs/fuentes (cache-first) y tiles (cap) ---
  if (url.origin !== self.location.origin) {
    if (CDN_HOSTS.includes(url.hostname)) {
      event.respondWith(cacheFirst(req, RUNTIME_CACHE));
      return;
    }
    if (TILE_HOST_RE.test(url.hostname)) {
      event.respondWith(cacheFirstCapped(req, TILE_CACHE, TILE_MAX));
      return;
    }
    return; // resto de lo externo: directo a la red
  }

  // --- Navegaciones: NETWORK-FIRST con timeout, fallback a cache ---
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetchWithTimeout(req, 3500);
        cachePut('./index.html', fresh);
        return fresh;
      } catch (e) {
        const cached = await matchAppShell(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // --- Resto del mismo origen: cache-first + revalidacion ---
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req)
      .then((res) => cachePut(req, res))
      .catch(() => cached);
    return cached || network;
  })());
});

// -- Permitir actualizacion inmediata desde la pagina ---------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
