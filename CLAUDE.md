# ArborRisk — Guía del proyecto (para Claude Code)

> App PWA para **gestión de riesgo biomecánico de árboles** (informes tipo ISA, Argentina).
> Esta guía es el mapa del proyecto: leela primero para no escanear las ~7.000 líneas del `index.html`.

## Qué es
- PWA instalable, **offline-first**, sin login, pensada para usar desde el celular en campo.
- Los datos (fichas + fotos) viven en **IndexedDB** del dispositivo (`ArborRiskDB`); las preferencias y el borrador en **`localStorage`**. No hay backend.
- Backup/restore manual vía **JSON** (export/import). Las fotos se resuelven a base64 dentro del JSON para que el backup sea portable.
- Se publica en **Cloudflare** (repo en GitHub → Cloudflare despliega solo).

## ⚠️ Trabajar sin quemar tokens — LEER PRIMERO

`index.html` pesa **~348 KB / ~7.200 líneas** (≈90k tokens). **Leerlo entero gasta un
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
5. **CSS** (31–1090) y **HTML/markup** (1091–2065) casi nunca hacen falta para
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
| **HTML / markup** (body, pestañas) | 1091–2065 |
| **JS** (cada módulo en su propio `<script>`) | 2066–7210 |

### Módulos JS (cada uno en su propio `<script>`)

Cada módulo arranca con un marcador `/* js/nombre.js */`. Saltá directo al rango:

| Módulo | Líneas | Rol |
|---|---|---|
| `js/db.js` | 2067–2409 | **IndexedDB** (`ArborRiskDB`, v2). Stores `records` y `photos`. Helpers `dbPutPhoto`/`dbGetPhoto`/`dbDeletePhoto`. |
| `js/state.js` | 2411–2599 | Estado global (`records`, `currentId`, `currentPhotos`, filtros, sort), autocompletar clientes/especies. |
| `js/forms_registro.js` | 2601–3477 | Formulario de registro rápido en campo (FAB, modal de nueva ficha). |
| `js/ui.js` | 3479–4261 | Render de listas/tarjetas, pestañas, vista de detalle, lightbox de fotos. |
| `js/forms.js` | 4263–4925 | Formulario completo de evaluación (ficha de riesgo biomecánico). |
| `js/pdf.js` | 4927–5408 | Generación de PDF con **jsPDF** (ficha individual y proyecto). |
| `js/sync.js` | 5410–5718 | **Export/import JSON** (backup). `exportData`/`resolveForExport`/`blobToDataUrl`, export PDF de proyecto. |
| `js/core.js` | 5720–5874 | Inicialización (`DOMContentLoaded`), `setupPWA()` (registra `./sw.js`), prompt de instalación. |
| `js/map.js` | 5876–6293 | Mapa Leaflet, clustering de marcadores, picker de GPS, **descarga de zona offline** (`downloadMapArea`/`runTileDownload`/`lngLatToTile`). |
| `js/projects.js` | 6295–6712 | Agrupación de fichas por cliente/proyecto. |
| `js/config.js` | 6714–7005 | Configuración (tema, datos del profesional, etc.). |
| `js/qr.js` | 7007–7209 | Etiquetas **QR** — **inactivo**: sin botones ni librería (Julio no usa QR). Si se reactiva, volver a cargar qrcodejs en el `<head>`. |

> Los rangos se mueven al editar. Si algo no cuadra, reubicá con
> `grep -n "js/nombre.js" index.html` y leé el banner.

### CSS (dentro de `<style>` bloques separados)

| Sección | Líneas | De qué se ocupa |
|---|---|---|
| `css/base.css` | 32–170 | Variables de tema (claro/oscuro), reset, tipografías. |
| `css/components.css` | 171–874 | Componentes de UI (tarjetas, formularios, badges de riesgo, lightbox). |
| `css/map.css` | 875–1089 | Estilos del mapa (Leaflet). |

## Arquitectura

- **Sin build, sin frameworks: JavaScript vanilla.** Todo el HTML + CSS + JS está en `index.html`.
- Cada módulo JS tiene su propio bloque `<script>` con ámbito global: las funciones se llaman
  entre sí y se usan en `onclick="..."`. **No convertir a módulos ES** sin refactorizar los handlers.
- **PWA con archivos reales:** `sw.js`, `manifest.webmanifest` e `icon.svg` son archivos separados.
  `setupPWA()` solo registra `./sw.js`.
- Librerías externas por CDN (cdnjs): **jsPDF**, **Leaflet** + **markercluster**, tiles de
  **OpenStreetMap**. El SW las cachea para offline. (qrcodejs se quitó: Julio no usa QR.)

## Estructura de archivos

- `index.html` — **toda la app** (markup + `<style>` + `<script>`).
- `sw.js` — Service Worker (offline + actualizaciones). `CACHE_VERSION` actual: `arborrisk-v5`.
- `manifest.webmanifest` — manifest PWA (instalación).
- `icon.svg` — icono vectorial.
- `CLAUDE.md` — esta guía.

## Persistencia

- **Fotos en IndexedDB, no en localStorage:** una foto se referencia por un ID; el blob vive en el store `photos`. Resolvé con `dbGetPhoto(id)`. Para el backup, `recordForExport()` convierte a base64 **todas** las fotos de una ficha (`photos`, `evaluaciones[].photos` y `registroPhotos[].id`). Usalo en cualquier export nuevo.
- **Importar:** después de cargar fichas de un archivo, llamar `migratePhotosToIDB(true)` (el `true` fuerza la migración base64 → blob aunque el flag `arborrisk_migrated_v2` ya esté puesto).
- **Restaurar backup** (`importData`): valida el archivo antes de tocar nada, descarta IDs que no cumplan `isSafeRecordId()` (se usan dentro de `onclick`), guarda una **copia previa** (`dbPutSnapshot`, en el store `photos` con id `snapshot_prerestore`) y reemplaza todo en **una sola transacción** (`dbReplaceAll`). `undoLastRestore()` la recupera (botón en el menú Sincronización). `cleanupOrphanPhotos()` no borra las fotos que referencia la copia previa.
- **Almacenamiento persistente:** `requestPersistentStorage()` al iniciar (sin eso el navegador puede borrar las fichas por falta de espacio).
- **Recordatorio de backup:** banner `#backup-banner` cada `BACKUP_REMINDER_DAYS` (7) días desde el último export (`arborrisk_last_backup`); "✕" pospone 1 día (`arborrisk_backup_snooze`). Todo export completo llama `markBackupDone()`.
- **localStorage solo para preferencias/borrador:** claves con prefijo `arborrisk_` (ej. `arborrisk_sort`, `pwa_dismissed`). No meter datos grandes ahí.

## Convenciones importantes

- **XSS / texto del usuario:** todo dato del usuario o de un archivo importado que vaya dentro de `innerHTML` (o de un string HTML como popups del mapa o la etiqueta QR) pasa por **`esc()`** (definida al principio de `js/db.js`). No usar `esc()` con `textContent` (ahí se vería `&amp;`).
- **Niveles de riesgo:** bajo / moderado / alto, con colores en variables CSS (`--low`, `--mod`, `--high`).

## PWA / Service Worker

- El SW es un archivo real: **`sw.js`**. `CACHE_VERSION` actual: **`arborrisk-v5`**. Estrategia: **network-first** en navegaciones + **cache-first** en el resto del mismo origen.
- `APP_SHELL` (en `sw.js`) precachea `./`, `./index.html`, `./manifest.webmanifest`, `./icon.svg`. **Si agregás un archivo local nuevo, sumalo a `APP_SHELL`** o se rompe el offline.
- **Cacheo de CDN:** el SW cachea cross-origin con cache-first (`CDN_HOSTS`: cdnjs, fonts.googleapis, fonts.gstatic).
- **Tiles de OSM:** cache `arborrisk-tiles` con tope `TILE_MAX` (FIFO, 2500). Quedan offline los tiles ya vistos + los de las zonas descargadas.
- **Caches de nombre fijo:** `arborrisk-cdn` (libs/fuentes) y `arborrisk-tiles` **no llevan la versión** en el nombre, así una actualización no borra las zonas descargadas ni deja la app sin jsPDF/Leaflet si se abre sin señal. Solo la cache del app shell (`CACHE_VERSION`) se renueva en cada deploy. El `activate` migra las caches viejas `<versión>-cdn`/`<versión>-tiles` a las fijas antes de borrarlas.
- **Descargar zona (offline dirigido):** el botón "⬇ Descargar zona" (`downloadMapArea`) calcula los tiles de la vista actual para los zooms `[z, z+2]` y los manda al SW por `postMessage({type:'CACHE_TILES', urls}, [port])`.

## Flujo de despliegue (SEGUIR SIEMPRE)

1. Desarrollar en la rama de trabajo (`claude/...`), no en `main`.
2. Mergear a `main` → el workflow **`.github/workflows/stamp-sw.yml`** corre `build.py`
   automáticamente y estampa `CACHE_VERSION` con timestamp. **No hace falta bump manual.**
   Red de seguridad: si ya viene estampado, no commitea nada.
3. Si agregás un archivo local nuevo, **sumarlo a `APP_SHELL` en `sw.js`** o se rompe el offline.
4. También podés correr `python build.py` a mano si necesitás forzar el bump antes de mergear.

### `build.py` y `.assetsignore`
- `build.py` reescribe la línea `const CACHE_VERSION = '...';` de `sw.js` con `arborrisk-<timestamp UTC>`.
- `.assetsignore` excluye del deploy a Cloudflare todo lo que no es la app: `wrangler.jsonc`, `.assetsignore`, `build.py`, `CLAUDE.md`, `.git`, `.github`, `.claude`, `.gitignore`, `.wrangler`, `node_modules`, `test`. Como el directorio de assets es la raíz del repo, **cualquier archivo nuevo que no sea de la app hay que sumarlo acá** (si no, queda público).
- Cloudflare redirige `/index.html` → `/` (307). Por eso `start_url` es `./` y el SW guarda las respuestas sin la marca de "redirigida" (`unredirect()`): Safari rechaza servir una respuesta redirigida en una navegación → la app no abriría offline.

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
node test/data.test.cjs   # backup/restauración/escapado — correrlo si tocás datos, export/import o renders
```
Para probar con la misma forma de servir de Cloudflare (incluido el 307 de `/index.html`), levantá `npx wrangler dev` y corré el test contra él:
```bash
ARBOR_BASE_URL=http://127.0.0.1:8787 node test/pwa.test.cjs
```

## Cosas que NO romper

- No pasar el JS a módulos ES (rompería los `onclick` globales).
- No olvidar que `build.py` / el workflow estampa `CACHE_VERSION` automáticamente — no tocar ese valor a mano.
- No volver a inyectar el SW inline desde `blob:` (no registra → sin offline).
- No mover los datos de IndexedDB a localStorage (riesgo de cuota y pérdida de fotos).

## Decisiones de producto (de Julio) — fuente de verdad

> ⚠️ **Mantener al día**: si Julio cambia alguna de estas reglas, editá esta sección.
> Una regla desactualizada acá genera implementaciones contradictorias.

- **Niveles de riesgo**: tres niveles — bajo / moderado / alto. Los colores están en variables CSS (`--low`, `--mod`, `--high`). No agregar niveles intermedios sin confirmación de Julio.
- **Ficha de riesgo**: el formulario principal sigue el esquema ISA adaptado para Argentina. No cambiar campos clave (especie, DAP, altura, nivel de riesgo) sin confirmar con Julio, ya que afecta los PDFs y los backups guardados.
- **Fotos por ficha**: las fotos se guardan en IndexedDB como blobs referenciados por ID. El backup JSON las exporta en base64 para portabilidad. No cambiar este esquema sin migrar los datos existentes.
- **Sin login / sin backend**: la app es intencionalmente sin cuentas. Todos los datos son locales. No agregar autenticación ni sync automático sin confirmación explícita de Julio.
- **PDF**: todos los PDF (ficha de riesgo, ficha de registro, proyecto, catastro) muestran **nombre y matrícula** del profesional (`profesionalPDF()`, datos de ⚙️ Configuración: `nombre`, `matricula`): arriba a la derecha del encabezado y en la aclaración de la firma. El PDF de proyecto agrupa fichas del mismo cliente. Si cambia el formato, verificar todos.
- **Trabaja solo**: no hay otros inspectores. El menú "BACKUP" muestra primero Backup / Restaurar; exportar/consolidar "de campo" y GeoJSON quedan en "Opciones avanzadas" (no borrar: sirven si algún día suma un colaborador).
- **Sin QR**: no usa etiquetas QR; se sacaron el botón de escaneo, el botón QR del detalle y la librería.
