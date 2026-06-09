# ArborRisk — Guía del proyecto (para Claude Code)

> App PWA para **gestión de riesgo biomecánico de árboles** (informes tipo ISA, Argentina).
> Esta guía es el mapa del proyecto: leela primero para no escanear las ~7.000 líneas del `index.html`.

## Qué es
- PWA instalable, **offline-first**, sin login, pensada para usar desde el celular en campo.
- Los datos (fichas + fotos) viven en **IndexedDB** del dispositivo (`ArborRiskDB`); las preferencias y el borrador en **`localStorage`**. No hay backend.
- Backup/restore manual vía **JSON** (export/import). Las fotos se resuelven a base64 dentro del JSON para que el backup sea portable.
- Se publica en **Cloudflare** (mismo esquema que la app de presupuestos: repo en GitHub → Cloudflare despliega solo).

## Arquitectura (importante)
- **Sin build, sin frameworks: JavaScript vanilla.** Todo el HTML + CSS + JS de la app está en **`index.html`**.
- Es una decisión deliberada (simplicidad, deploy trivial). No usar bundlers ni frameworks.
- El JS está todo en **un solo `<script>` con ámbito global**: las funciones se llaman entre sí y se usan en `onclick="..."`. **No convertir a módulos ES** sin refactorizar los handlers.
- **PWA con archivos reales:** el Service Worker (`sw.js`), el manifest (`manifest.webmanifest`) y el icono (`icon.svg`) son **archivos separados** (no se inyectan inline). `setupPWA()` solo registra `./sw.js`. El `<head>` enlaza el manifest y los iconos. _(En el build35 original todo esto era inline vía Blob URL; se extrajo porque registrar un SW desde `blob:` falla en navegadores modernos → no había offline real.)_
- Librerías externas por CDN (cdnjs): **jsPDF**, **Leaflet** + **markercluster**, **qrcodejs**, y tiles de **OpenStreetMap**. El Service Worker **las cachea** (cache-first) para que funcionen offline después de la primera carga online (ver sección PWA).

## Estructura de archivos
- `index.html` — **toda la app** (markup + `<style>` + `<script>`).
- `sw.js` — Service Worker (offline + actualizaciones). **`CACHE_VERSION` actual: `arborrisk-v5`**.
- `manifest.webmanifest` — manifest PWA (instalación).
- `icon.svg` — icono vectorial (usado por el manifest y como `apple-touch-icon`/`favicon`).
- `CLAUDE.md` — esta guía.

## Mapa del código dentro de `index.html`
El CSS y el JS están organizados por secciones marcadas con comentarios `/* css/<nombre>.css */` y `/* js/<nombre>.js */`.
**Buscá esos marcadores** (son anclas estables) en vez de fiarte de números de línea.

Comando rápido para listarlos:
```bash
grep -nE "css/[a-z]+\.css|js/[a-z]+\.js" index.html
```

| Sección | De qué se ocupa |
|---|---|
| `css/base.css` | Variables de tema (claro/oscuro), reset, tipografías |
| `css/components.css` | Componentes de UI (tarjetas, formularios, badges de riesgo, lightbox) |
| `css/map.css` | Estilos del mapa (Leaflet) |
| `js/db.js` | **IndexedDB** (`ArborRiskDB`, v2). Stores `records` y `photos`. Helpers `dbPutPhoto`/`dbGetPhoto`/`dbDeletePhoto` |
| `js/state.js` | Estado global (`records`, `currentId`, `currentPhotos`, filtros, sort), autocompletar clientes/especies |
| `js/ui.js` | Render de listas/tarjetas, pestañas, vista de detalle, lightbox de fotos |
| `js/forms.js` | Formularios de evaluación (carga de la ficha de riesgo) |
| `js/pdf.js` | Generación de PDF con **jsPDF** (ficha individual y proyecto) |
| `js/sync.js` | **Export/import JSON** (backup). `exportData`/`resolveForExport`/`blobToDataUrl`, export PDF de proyecto |
| `js/core.js` | Inicialización (`DOMContentLoaded`), `setupPWA()` (registra `./sw.js`), prompt de instalación |
| `js/map.js` | Mapa Leaflet, clustering de marcadores, picker de GPS, **descarga de zona offline** (`downloadMapArea`/`runTileDownload`/`lngLatToTile`) |
| `js/projects.js` | Agrupación de fichas por cliente/proyecto |
| `js/config.js` | Configuración (tema, datos del profesional, etc.) |
| `js/qr.js` | Generación de etiquetas con **QR** por ficha |

## Convenciones importantes
- **Fotos en IndexedDB, no en localStorage:** una foto se referencia por un ID; el blob vive en el store `photos`. Resolvé con `dbGetPhoto(id)`. Para el backup, `resolveForExport()` convierte los IDs a base64.
- **localStorage solo para preferencias/borrador:** claves con prefijo `arborrisk_` (ej. `arborrisk_sort`, `pwa_dismissed`). No meter datos grandes ahí.
- **XSS:** escapar SIEMPRE los datos del usuario antes de meterlos en `innerHTML` (varios render usan `.replace(/"/g,'&quot;')` y similares — mantener el patrón).
- **Niveles de riesgo:** bajo / moderado / alto, con colores en variables CSS (`--low`, `--mod`, `--high`).

## PWA / Service Worker (detalles que no romper)
- El SW es un archivo real: **`sw.js`**. `CACHE_VERSION` actual: **`arborrisk-v5`** (constante arriba de `sw.js`). Estrategia: **network-first** en navegaciones (con timeout y fallback a caché) + **cache-first** en el resto del mismo origen. Mismo patrón que el `sw.js` de presupuestos.
- `APP_SHELL` (en `sw.js`) precachea `./`, `./index.html`, `./manifest.webmanifest`, `./icon.svg`. **Si agregás un archivo local nuevo, sumalo a `APP_SHELL`** o se rompe el offline.
- **Cacheo de CDN (offline total):** el SW cachea cross-origin con **cache-first**:
  - `CDN_HOSTS` (`cdnjs.cloudflare.com`, `fonts.googleapis.com`, `fonts.gstatic.com`) → cache `…-cdn`. Cubre jsPDF, Leaflet, markercluster, QR y las fuentes. Se cachean **en la primera carga online**; después funcionan offline.
  - Tiles de OSM (`*.tile.openstreetmap.org`) → cache `…-tiles` con **tope `TILE_MAX` (FIFO, 2500)**. Quedan offline los tiles **ya vistos** + los de las **zonas descargadas** (ver abajo).
  - Se aceptan respuestas **opacas** (no-cors), por eso `cacheFirst` no exige `status===200`.
  - El `activate` mantiene las 3 caches de la versión actual (`CURRENT_CACHES`) y borra las viejas. Al subir `CACHE_VERSION` se renuevan las 3 (incluida la de tiles).
- **Descargar zona (offline dirigido):** el botón "⬇ Descargar zona" del mapa (`downloadMapArea`) calcula los tiles de la vista actual para los zooms `[z, z+2]` (replicando el esquema de subdominios `a/b/c` de Leaflet para que las claves de caché coincidan) y se los manda al SW por `postMessage({type:'CACHE_TILES', urls}, [port])`. El SW (`cacheTileList`) los descarga con concurrencia y reporta progreso por el `MessagePort`. Así una zona elegida queda 100% offline aunque no se haya recorrido tile por tile.
- `start_url` `./index.html`, scope `./` (en `manifest.webmanifest`).

## Flujo de despliegue (SEGUIR SIEMPRE)
1. Desarrollar en la rama de trabajo (`claude/...`), no en `main`.
2. **Subir `CACHE_VERSION` en `sw.js`** en cada cambio que se despliegue (si no, los dispositivos siguen con la versión vieja en caché). Formato: `arborrisk-vNN`.
3. Si agregás un archivo local nuevo (otro `.js`, `.css`, icono), **agregarlo a `APP_SHELL` en `sw.js`** o se rompe el offline.
4. Mergear a `main` → Cloudflare despliega solo (mismo esquema que presupuestos).

## Cómo verificar cambios (sin romper)
**Sintaxis JS** — aislar el `<script>` inline y verificar con node:
```bash
python3 - <<'PY'
import re, subprocess, sys
html = open('index.html', encoding='utf-8').read()
js = "\n;\n".join(re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S))
open('/tmp/arbor_check.js','w',encoding='utf-8').write(js)
sys.exit(subprocess.run(['node','--check','/tmp/arbor_check.js']).returncode)
PY
```

**Comportamiento (navegador headless):** en sesiones de Claude Code on the web, el SessionStart hook (`.claude/hooks/session-start.sh`) deja instalado `chrome-headless-shell` + `puppeteer-core`. Hay un test listo que valida SW real, offline del app-shell, el mecanismo de descarga de zona y la matemática de tiles:
```bash
node test/pwa.test.cjs
```
Parsea el `CACHE_VERSION` de `sw.js`, así que no hay que tocarlo al subir la versión. _(La network policy del entorno puede bloquear cdnjs/OSM; por eso el test no depende de recursos externos.)_

## Cosas que NO romper
- No pasar el JS a módulos ES (rompería los `onclick` globales).
- No olvidar subir `CACHE_VERSION` en `sw.js` al desplegar.
- No volver a inyectar el SW inline desde `blob:` (no registra → sin offline).
- No mover los datos de IndexedDB a localStorage (riesgo de cuota y pérdida de fotos).
