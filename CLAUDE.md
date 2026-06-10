# ArborRisk — Guía del proyecto (para Claude Code)

> App PWA para **gestión de riesgo biomecánico de árboles** (informes tipo ISA, Argentina).
> Esta guía es el mapa del proyecto: leela primero para no escanear las ~7.000 líneas del `index.html`.

## Qué es
- PWA instalable, **offline-first**, sin login, pensada para usar desde el celular en campo.
- Los datos (fichas + fotos) viven en **IndexedDB** del dispositivo (`ArborRiskDB`); las preferencias y el borrador en **`localStorage`**. No hay backend.
- Backup/restore manual vía **JSON** (export/import). Las fotos se resuelven a base64 dentro del JSON para que el backup sea portable.
- Se publica en **Cloudflare** (repo en GitHub → Cloudflare despliega solo).

## ⚠️ Trabajar sin quemar tokens — LEER PRIMERO

`index.html` pesa **~343 KB / ~6.983 líneas** (≈85k tokens). **Leerlo entero gasta un
contexto casi completo de una.** Pero está limpio y dividido en secciones con marcadores
`/* css/nombre.css */` y `/* js/nombre.js */`. Por eso la **lectura por rangos de línea
es exacta y barata**. Reglas:

1. **NUNCA** hagas `Read` del archivo completo (sin `offset`/`limit`). Tampoco
   `cat`/`sed` de todo el archivo.
2. Para localizar algo: `Grep -n` del símbolo/función/string → te da la línea
   exacta → `Read` con `offset`/`limit` solo ese tramo (±30 líneas).
3. Para saltar a un módulo: usá la columna **Líneas** de la tabla de abajo y
   `Read` ese rango directamente.
4. Para **editar**: `Grep` el `old_string` único → `Read` solo esa franja →
   `Edit`. No vuelvas a leer el archivo después de editar (el harness ya valida
   el cambio).
5. **CSS** (31–1090) y **HTML/markup** (1091–2053) casi nunca hacen falta para
   lógica de negocio — no los leas salvo trabajo de estilos o maquetado.
6. Si un rango no cuadra (el archivo creció), reubicá con:
   ```bash
   grep -n "js/nombre.js\|css/nombre.css" index.html
   ```

### Mapa de regiones

| Región | Líneas |
|---|---|
| `<head>` + CDN scripts | 1–29 |
| **CSS** (3 bloques `<style>`) | 31–1090 |
| **HTML / markup** (body, pestañas) | 1091–2053 |
| **JS** (cada módulo en su propio `<script>`) | 2055–6980 |

### Módulos JS (cada uno en su propio `<script>`)

Cada módulo arranca con un marcador `/* js/nombre.js */`. Saltá directo al rango:

| Módulo | Líneas | Rol |
|---|---|---|
| `js/db.js` | 2055–2310 | **IndexedDB** (`ArborRiskDB`, v2). Stores `records` y `photos`. Helpers `dbPutPhoto`/`dbGetPhoto`/`dbDeletePhoto`. |
| `js/state.js` | 2311–2500 | Estado global (`records`, `currentId`, `currentPhotos`, filtros, sort), autocompletar clientes/especies. |
| `js/forms_registro.js` | 2501–3313 | Formulario de registro rápido en campo (FAB, modal de nueva ficha). |
| `js/ui.js` | 3314–4097 | Render de listas/tarjetas, pestañas, vista de detalle, lightbox de fotos. |
| `js/forms.js` | 4098–4761 | Formulario completo de evaluación (ficha de riesgo biomecánico). |
| `js/pdf.js` | 4762–5244 | Generación de PDF con **jsPDF** (ficha individual y proyecto). |
| `js/sync.js` | 5245–5473 | **Export/import JSON** (backup). `exportData`/`resolveForExport`/`blobToDataUrl`, export PDF de proyecto. |
| `js/core.js` | 5474–5629 | Inicialización (`DOMContentLoaded`), `setupPWA()` (registra `./sw.js`), prompt de instalación. |
| `js/map.js` | 5630–6048 | Mapa Leaflet, clustering de marcadores, picker de GPS, **descarga de zona offline** (`downloadMapArea`/`runTileDownload`/`lngLatToTile`). |
| `js/projects.js` | 6049–6467 | Agrupación de fichas por cliente/proyecto. |
| `js/config.js` | 6468–6774 | Configuración (tema, datos del profesional, etc.). |
| `js/qr.js` | 6776–6980 | Generación de etiquetas con **QR** por ficha. |

> Los rangos se mueven al editar. Si algo no cuadra, reubicá con
> `grep -n "js/nombre.js" index.html` y leé el banner.

### CSS (dentro de `<style>` bloques separados)

| Sección | Líneas | De qué se ocupa |
|---|---|---|
| `css/base.css` | 31–169 | Variables de tema (claro/oscuro), reset, tipografías. |
| `css/components.css` | 170–873 | Componentes de UI (tarjetas, formularios, badges de riesgo, lightbox). |
| `css/map.css` | 874–1090 | Estilos del mapa (Leaflet). |

## Arquitectura

- **Sin build, sin frameworks: JavaScript vanilla.** Todo el HTML + CSS + JS está en `index.html`.
- Cada módulo JS tiene su propio bloque `<script>` con ámbito global: las funciones se llaman
  entre sí y se usan en `onclick="..."`. **No convertir a módulos ES** sin refactorizar los handlers.
- **PWA con archivos reales:** `sw.js`, `manifest.webmanifest` e `icon.svg` son archivos separados.
  `setupPWA()` solo registra `./sw.js`.
- Librerías externas por CDN (cdnjs): **jsPDF**, **Leaflet** + **markercluster**, **qrcodejs**,
  tiles de **OpenStreetMap**. El SW las cachea para offline.

## Estructura de archivos

- `index.html` — **toda la app** (markup + `<style>` + `<script>`).
- `sw.js` — Service Worker (offline + actualizaciones). `CACHE_VERSION` actual: `arborrisk-v5`.
- `manifest.webmanifest` — manifest PWA (instalación).
- `icon.svg` — icono vectorial.
- `CLAUDE.md` — esta guía.

## Persistencia

- **Fotos en IndexedDB, no en localStorage:** una foto se referencia por un ID; el blob vive en el store `photos`. Resolvé con `dbGetPhoto(id)`. Para el backup, `resolveForExport()` convierte los IDs a base64.
- **localStorage solo para preferencias/borrador:** claves con prefijo `arborrisk_` (ej. `arborrisk_sort`, `pwa_dismissed`). No meter datos grandes ahí.

## Convenciones importantes

- **XSS:** escapar SIEMPRE los datos del usuario antes de meterlos en `innerHTML` (varios render usan `.replace(/"/g,'&quot;')` y similares — mantener el patrón).
- **Niveles de riesgo:** bajo / moderado / alto, con colores en variables CSS (`--low`, `--mod`, `--high`).

## PWA / Service Worker

- El SW es un archivo real: **`sw.js`**. `CACHE_VERSION` actual: **`arborrisk-v5`**. Estrategia: **network-first** en navegaciones + **cache-first** en el resto del mismo origen.
- `APP_SHELL` (en `sw.js`) precachea `./`, `./index.html`, `./manifest.webmanifest`, `./icon.svg`. **Si agregás un archivo local nuevo, sumalo a `APP_SHELL`** o se rompe el offline.
- **Cacheo de CDN:** el SW cachea cross-origin con cache-first (`CDN_HOSTS`: cdnjs, fonts.googleapis, fonts.gstatic).
- **Tiles de OSM:** cache `…-tiles` con tope `TILE_MAX` (FIFO, 2500). Quedan offline los tiles ya vistos + los de las zonas descargadas.
- **Descargar zona (offline dirigido):** el botón "⬇ Descargar zona" (`downloadMapArea`) calcula los tiles de la vista actual para los zooms `[z, z+2]` y los manda al SW por `postMessage({type:'CACHE_TILES', urls}, [port])`.

## Flujo de despliegue (SEGUIR SIEMPRE)

1. Desarrollar en la rama de trabajo (`claude/...`), no en `main`.
2. **Subir `CACHE_VERSION` en `sw.js`** en cada cambio que se despliegue. Formato: `arborrisk-vNN`. **No hay workflow automático**: hay que hacerlo a mano siempre.
3. Si agregás un archivo local nuevo, **sumarlo a `APP_SHELL` en `sw.js`** o se rompe el offline.
4. Mergear a `main` → Cloudflare despliega solo.

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

**Comportamiento (navegador headless):** en sesiones de Claude Code on the web, el SessionStart hook (`.claude/hooks/session-start.sh`) deja instalado `chrome-headless-shell` + `puppeteer-core`. Test completo:
```bash
node test/pwa.test.cjs
```

## Cosas que NO romper

- No pasar el JS a módulos ES (rompería los `onclick` globales).
- No olvidar subir `CACHE_VERSION` en `sw.js` al desplegar (**manual**, no hay workflow automático).
- No volver a inyectar el SW inline desde `blob:` (no registra → sin offline).
- No mover los datos de IndexedDB a localStorage (riesgo de cuota y pérdida de fotos).

## Decisiones de producto (de Julio) — fuente de verdad

> ⚠️ **Mantener al día**: si Julio cambia alguna de estas reglas, editá esta sección.
> Una regla desactualizada acá genera implementaciones contradictorias.

- **Niveles de riesgo**: tres niveles — bajo / moderado / alto. Los colores están en variables CSS (`--low`, `--mod`, `--high`). No agregar niveles intermedios sin confirmación de Julio.
- **Ficha de riesgo**: el formulario principal sigue el esquema ISA adaptado para Argentina. No cambiar campos clave (especie, DAP, altura, nivel de riesgo) sin confirmar con Julio, ya que afecta los PDFs y los backups guardados.
- **Fotos por ficha**: las fotos se guardan en IndexedDB como blobs referenciados por ID. El backup JSON las exporta en base64 para portabilidad. No cambiar este esquema sin migrar los datos existentes.
- **Sin login / sin backend**: la app es intencionalmente sin cuentas. Todos los datos son locales. No agregar autenticación ni sync automático sin confirmación explícita de Julio.
- **PDF individual y de proyecto**: el PDF de ficha individual incluye datos del profesional (configurados en `js/config.js`). El PDF de proyecto agrupa fichas del mismo cliente. Si cambia el formato, verificar los dos tipos.
