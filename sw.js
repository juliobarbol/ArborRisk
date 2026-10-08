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
//  Para forzar actualizacion tras un deploy: subir el CACHE_VERSION (lo
//  estampa build.py solo). Solo renueva el app shell: libs y tiles viven en
//  caches de nombre fijo y sobreviven a las actualizaciones.

const CACHE_VERSION = 'arborrisk-20261008-155418';
// Libs/fuentes y tiles van en caches de nombre FIJO (sin la version): asi
// una actualizacion de la app no borra los mapas descargados ni deja la app
// sin jsPDF/Leaflet si la proxima apertura es sin senal. Sus URLs son
// inmutables (cdnjs versiona en la ruta), no hace falta renovarlas.
const RUNTIME_CACHE = 'arborrisk-cdn';    // libs + fuentes
const TILE_CACHE    = 'arborrisk-tiles';  // tiles OSM (con tope)
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
// Tiles del mapa: cache-first con tope (FIFO). El tope es generoso para que
// una "descarga de zona" (varios niveles de zoom) entre completa.
const TILE_HOST_RE = /(^|\.)tile\.openstreetmap\.org$/;
const TILE_MAX = 2500;

// -- Install: precachear el app shell (resiliente) ------------
// Si un recurso puntual falla (red intermitente durante el deploy), NO
// abortamos toda la instalacion: cacheamos lo que se pueda y seguimos.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.allSettled(APP_SHELL.map(async (url) => {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, await unredirect(res));
    }));
    await self.skipWaiting();
  })());
});

// -- Activate: limpiar caches viejos y tomar control ----------
// Borra el app shell de versiones anteriores. Las caches viejas de libs y
// tiles (de cuando llevaban la version en el nombre: '<version>-cdn' y
// '<version>-tiles') se migran a las de nombre fijo antes de borrarlas,
// para no perder las zonas ya descargadas.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    for (const k of keys) {
      if (CURRENT_CACHES.includes(k)) continue;
      if (k.endsWith('-tiles')) await migrateCache(k, TILE_CACHE);
      else if (k.endsWith('-cdn')) await migrateCache(k, RUNTIME_CACHE);
      await caches.delete(k);
    }
    await trimCache(TILE_CACHE, TILE_MAX);
    await self.clients.claim();
  })());
});

// -- Helper: copiar entradas de una cache a otra (sin pisar) --
async function migrateCache(fromName, toName) {
  try {
    const from = await caches.open(fromName);
    const to = await caches.open(toName);
    for (const req of await from.keys()) {
      if (await to.match(req)) continue;
      const res = await from.match(req);
      if (res) await to.put(req, res);
    }
  } catch (e) { /* noop: en el peor caso se vuelve a descargar */ }
}

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

// -- Helper: quitar la marca de "redirigida" a una respuesta --
// Cloudflare (Workers/Pages) redirige /index.html → / (307). Si esa
// respuesta se guarda tal cual, queda marcada como redirigida y Safari
// la rechaza al servirla en una navegacion (la app no abre sin senal).
// Se reconstruye con el mismo cuerpo y headers, sin la marca.
async function unredirect(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
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
        return cached ? unredirect(cached) : Response.error();
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

// -- Mensajes desde la pagina ---------------------------------
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING') { self.skipWaiting(); return; }
  // Descarga de zona del mapa: cachea una lista de tiles y reporta progreso
  // por el MessagePort (event.ports[0]).
  if (data && data.type === 'CACHE_TILES' && Array.isArray(data.urls)) {
    cacheTileList(data.urls, event.ports && event.ports[0]);
  }
});

// -- Descargar y cachear una lista de tiles (con progreso) ----
async function cacheTileList(urls, port) {
  const cache = await caches.open(TILE_CACHE);
  const total = urls.length;
  let done = 0, ok = 0, i = 0;
  const CONCURRENCY = 6;

  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const existing = await cache.match(url);
        if (existing) {
          ok++;
        } else {
          const res = await fetch(url, { mode: 'no-cors' });
          if (res && (res.status === 200 || res.type === 'opaque')) {
            await cache.put(url, res.clone());
            ok++;
          }
        }
      } catch (e) { /* tile que falla: se omite */ }
      done++;
      if (port) port.postMessage({ done, total, ok });
    }
  }

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  await trimCache(TILE_CACHE, TILE_MAX);
  if (port) port.postMessage({ done: total, total, ok, finished: true });
}
