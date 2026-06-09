//  sw.js - Service Worker - ArborRisk (Gestion de Riesgo Biomecanico)
//  Estrategia (robusta ante actualizaciones):
//   - Navegaciones (abrir la app): NETWORK-FIRST con timeout y fallback
//     a cache. Al abrir, siempre intentamos traer la version nueva desde
//     la red; si no hay senal (o tarda), servimos la cacheada. Asi la app
//     instalada NUNCA queda pegada a una version vieja o rota.
//   - Resto de recursos del mismo origen: cache-first + revalidacion en
//     segundo plano.
//   - Nunca cacheamos respuestas redirigidas ni != 200 (evita corromper
//     la cache).
//   - Recursos externos (cdnjs: jsPDF, Leaflet, QR; tiles de OSM; fuentes
//     de Google): pasan directo a la red (no se cachean).
//
//  Para forzar actualizacion tras un deploy: subir el CACHE_VERSION.

const CACHE_VERSION = 'arborrisk-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

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
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// -- Helper: cachear solo respuestas "sanas" ------------------
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

// -- Fetch ----------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo GET del mismo origen. Lo externo (cdnjs, tiles, fuentes) va directo.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navegaciones: NETWORK-FIRST con timeout, fallback a cache.
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

  // Resto del mismo origen: cache-first + revalidacion en segundo plano.
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
