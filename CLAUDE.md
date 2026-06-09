# ArborRisk — Guía del proyecto (para Claude Code)

> App PWA para **gestión de riesgo biomecánico de árboles** (informes tipo ISA, Argentina).
> Esta guía es el mapa del proyecto: leela primero para no escanear las ~7.000 líneas del `index.html`.

## Qué es
- PWA instalable, **offline-first**, sin login, pensada para usar desde el celular en campo.
- Los datos (fichas + fotos) viven en **IndexedDB** del dispositivo (`ArborRiskDB`); las preferencias y el borrador en **`localStorage`**. No hay backend.
- Backup/restore manual vía **JSON** (export/import). Las fotos se resuelven a base64 dentro del JSON para que el backup sea portable.
- Se va a publicar en **Cloudflare** (mismo esquema que la app de presupuestos: repo en GitHub → Cloudflare despliega solo).

## Arquitectura (importante)
- **Sin build, sin frameworks: JavaScript vanilla.** Todo el HTML + CSS + JS está en **un único `index.html`** autocontenido.
- Es una decisión deliberada (simplicidad, deploy de un archivo, offline trivial). No usar bundlers ni frameworks.
- El JS está todo en **un solo `<script>` con ámbito global**: las funciones se llaman entre sí y se usan en `onclick="..."`. **No convertir a módulos ES** sin refactorizar los handlers.
- **El manifest PWA y el Service Worker se generan inline** (Blob URL) dentro de `setupPWA()` — NO hay archivos `manifest.webmanifest` ni `sw.js` separados, ni iconos `.png` (el icono es un SVG embebido en el manifest).
- Librerías externas por CDN (cdnjs): **jsPDF**, **Leaflet** + **markercluster**, **qrcodejs**. Requieren conexión la primera vez (no están cacheadas como app shell).

## Estructura de archivos
- `index.html` — **toda la app** (markup + `<style>` + `<script>`). Único archivo que se despliega.
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
| `js/core.js` | Inicialización (`DOMContentLoaded`), `setupPWA()` (manifest + Service Worker inline), prompt de instalación |
| `js/map.js` | Mapa Leaflet, clustering de marcadores, picker de GPS |
| `js/projects.js` | Agrupación de fichas por cliente/proyecto |
| `js/config.js` | Configuración (tema, datos del profesional, etc.) |
| `js/qr.js` | Generación de etiquetas con **QR** por ficha |

## Convenciones importantes
- **Fotos en IndexedDB, no en localStorage:** una foto se referencia por un ID; el blob vive en el store `photos`. Resolvé con `dbGetPhoto(id)`. Para el backup, `resolveForExport()` convierte los IDs a base64.
- **localStorage solo para preferencias/borrador:** claves con prefijo `arborrisk_` (ej. `arborrisk_sort`, `pwa_dismissed`). No meter datos grandes ahí.
- **XSS:** escapar SIEMPRE los datos del usuario antes de meterlos en `innerHTML` (varios render usan `.replace(/"/g,'&quot;')` y similares — mantener el patrón).
- **Niveles de riesgo:** bajo / moderado / alto, con colores en variables CSS (`--low`, `--mod`, `--high`).

## PWA / Service Worker (detalles que no romper)
- El SW y el manifest se inyectan en `setupPWA()` (sección `js/core.js`). El `CACHE_VERSION` actual es **`arborrisk-v2`** (variable dentro de `setupPWA`).
- **Para forzar actualización tras un deploy: subir el `CACHE_VERSION`** (formato `arborrisk-vNN`), igual que en presupuestos.
- `start_url` y el scope son `'.'` (raíz). El SW cachea el documento y sirve offline-first. Las libs por CDN no están en el app shell.

## Flujo de despliegue (SEGUIR SIEMPRE)
1. Desarrollar en la rama de trabajo (`claude/...`), no en `main`.
2. **Subir `CACHE_VERSION`** en `setupPWA()` en cada cambio que se despliegue (si no, los dispositivos siguen con la versión vieja en caché). Formato: `arborrisk-vNN`.
3. Mergear a `main` → Cloudflare despliega solo (mismo esquema que presupuestos).

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

**Comportamiento:** se puede manejar la app con un navegador headless (puppeteer/chrome-headless-shell) cargando `file://.../index.html`.

## Cosas que NO romper
- No pasar el JS a módulos ES (rompería los `onclick` globales).
- No separar el archivo: la app es **un único `index.html`** por diseño.
- No olvidar subir `CACHE_VERSION` al desplegar.
- No mover los datos de IndexedDB a localStorage (riesgo de cuota y pérdida de fotos).
