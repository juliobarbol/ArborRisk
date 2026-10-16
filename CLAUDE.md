# ArborRisk — Guía del proyecto (para Claude Code)

> App PWA para **gestión de riesgo biomecánico de árboles** (informes tipo ISA, Argentina).
> Esta guía es el mapa del proyecto: leela primero para no escanear las ~7.000 líneas del `index.html`.

## Qué es
- PWA instalable, **offline-first**, pensada para usar desde el celular en campo. Login solo para la nube (opcional).
- Los datos (fichas + fotos) viven en **IndexedDB** del dispositivo (`ArborRiskDB`); las preferencias y el borrador en **`localStorage`**.
- **Nube opcional (Supabase):** con sesión iniciada, las fichas y fotos se sincronizan entre dispositivos (ver sección *Nube*). Sin sesión, la app funciona igual que siempre, 100% local.
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
- `sw.js` — Service Worker (offline + actualizaciones). **`CACHE_VERSION` actual: `arborrisk-v8`**.
- `manifest.webmanifest` — manifest PWA (instalación).
- `icon.svg` — icono vectorial (usado por el manifest y como `apple-touch-icon`/`favicon`).
- `supabase/migrations/` — esquema del servidor (tablas, RLS, `sync_push`, bucket de fotos). `supabase/README.md` — cómo crear una instancia nueva y correr el test de nube.
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
| `js/db.js` | **IndexedDB** (`ArborRiskDB`, **v3**). Stores `records`, `photos`, `outbox` (cambios pendientes de subir) y `nube_fotos` (fotos ya subidas). Helpers `dbPutPhoto`/`dbGetPhoto`/`dbDeletePhoto`, `idbAll/idbGet/idbPut/idbDelete` |
| `js/state.js` | Estado global (`records`, `currentId`, `currentPhotos`, filtros, sort), autocompletar clientes/especies |
| `js/ui.js` | Render de listas/tarjetas, pestañas, vista de detalle, lightbox de fotos |
| `js/forms.js` | Formularios de evaluación (carga de la ficha de riesgo) |
| `js/pdf.js` | Generación de PDF con **jsPDF** (ficha individual y proyecto) |
| `js/sync.js` | **Export/import JSON** (backup). `exportData`/`resolveForExport`/`blobToDataUrl`, export PDF de proyecto |
| `js/core.js` | Inicialización (`DOMContentLoaded`), `setupPWA()` (registra `./sw.js`), prompt de instalación |
| `js/map.js` | Mapa Leaflet, clustering de marcadores, picker de GPS, **descarga de zona offline** (`downloadMapArea`/`runTileDownload`/`lngLatToTile`) |
| `js/projects.js` | Agrupación de fichas por cliente/proyecto |
| `js/config.js` | Configuración (tema, datos del profesional, etc.), export de campo, **GeoJSON**, **CSV** (`exportCSV`, `;` + coma decimal para Excel AR) y **consolidación** (`mergeImportData`) |
| `js/nube.js` | **Sincronización con Supabase** por REST (sin SDK): login/registro, `nubeSync` (push por `sync_push` + pull incremental), fotos al Storage, roles, modal ☁ e indicador del header |
| `js/qr.js` | Generación de etiquetas con **QR** por ficha |

## Convenciones importantes
- **Fotos en IndexedDB, no en localStorage:** una foto se referencia por un ID; el blob vive en el store `photos`. Resolvé con `dbGetPhoto(id)`. Para el backup, `resolveForExport()` convierte los IDs a base64.
- **localStorage solo para preferencias/borrador:** claves con prefijo `arborrisk_` (ej. `arborrisk_sort`, `pwa_dismissed`). No meter datos grandes ahí.
- **XSS:** escapar SIEMPRE los datos del usuario con **`esc()`** (en `js/state.js`) antes de meterlos en `innerHTML` o en atributos. Es crítico porque "Consolidar" importa fichas de otros dispositivos. No escapar en `textContent` ni en `doc.text` (PDF).
- **IDs de ficha:** se generan con `newRecordId()` (UUID). Se insertan en handlers `onclick`, así que al importar/consolidar se descartan los que no pasan `isSafeId()`.
- **Campos nuevos en una ficha:** `saveRecord()` y `saveRegistroRecord()` **reconstruyen el objeto campo por campo**; un campo que no esté listado ahí se pierde al editar.
- **GPS:** usar `setGpsMeta(fieldId, valor, fuente, precision)` para cargar coordenadas y `readGpsMeta(fieldId)` al guardar. Guardan `gpsFuente` (`gps`/`mapa`/`manual`) y `gpsPrecision` (m). Editar las coordenadas a mano las marca como `manual`.
- **Autoría:** `auditFields(existing)` agrega `creadoPor`, `creadoEn`, `modificadoPor`, `deviceId`. `recordInspector(r)` resuelve el inspector de una ficha (para exportaciones).
- **Modelo árbol + evaluaciones:** la ficha de **registro** (`tipo:'registro'`) es el árbol/sitio inventariado; una ficha de **riesgo** se vincula a él con **`arbolId`** (campo "Árbol del inventario" o botón "＋ Evaluación de riesgo" del detalle → `openEvalFromArbol`). Helpers: `arbolDeEvaluacion`, `evaluacionesDeArbol`, `ultimaEvaluacion`, `registroPorCodigo`. Una ficha de riesgo con `arbolId` inexistente se trata como independiente.
- **Estadísticas del catastro:** usar **`calcCatastroStats()`** (panel y PDF). Cuenta por árbol (registro + riesgo no vinculadas), separa sitios sin árbol (`esSitioSinArbol`: tocón, cazuela vacía, apto para plantar) y toma el riesgo de la última evaluación. No volver a contar `records.length` como árboles.
- **Catálogo de especies** (`/* js/catalogo.js */`, `ESPECIES_CATALOGO`): `normalizarEspecie()` se aplica al guardar; `buscarEspecie()` da nombre común, origen e invasora. No agregar sinónimos de género ("olmo", "roble"): asignarían una especie no verificada.
- **Campos de sitio del registro:** `condicionSitio`, `calle`, `numero`, `emplazamiento`, `conflictos` (labels en `CONDICION_LABEL`/`EMPLAZAMIENTO_LABEL`).
- **Migración de vínculos:** el panel Catastro sugiere pares evaluación↔registro a < `VINCULO_MAX_M` m y misma especie (`candidatosVinculo`, grilla espacial); el usuario confirma. Nunca vincular automáticamente.
- **Exportaciones con muchas fichas:** usar `indexById()` en vez de `records.find` por fila.
- **Lista paginada:** `renderList()` muestra `LIST_PAGE_SIZE` tarjetas y un botón "Mostrar más"; no volver a insertar todas.
- **Niveles de riesgo:** bajo / moderado / alto, con colores en variables CSS (`--low`, `--mod`, `--high`).

## Nube (Supabase) — detalles que no romper
- **Instancia = proyecto de Supabase.** La predeterminada está en `NUBE_DEFAULT` (`js/nube.js`); se puede cambiar desde el modal ☁ → "Cambiar servidor". La clave publicable es pública por diseño: la seguridad está en RLS y en las funciones del servidor.
- **Escritura local siempre por `dbPut`/`dbDelete`:** con sesión, encolan el cambio en `outbox` **en la misma transacción**. Lo que viene de la nube se aplica con `{ noSync: true }` (si no, se reenviaría).
- **`updatedAt` decide los conflictos** (gana el más reciente, por ficha). Al modificar una ficha usar **`marcaTiempo(prev.updatedAt)`**, nunca `new Date()` a secas: evita que un dispositivo con el reloj adelantado gane siempre.
- **Borrados:** son lógicos en el servidor (`deleted_at`) y se propagan. Un relevador solo borra lo que cargó; si no puede, la ficha se restaura.
- **Pull incremental** por `server_updated_at` (cursor en `localStorage`, por servidor+usuario) releyendo 1 minuto hacia atrás; aplicar una fila dos veces es inocuo.
- **Fotos:** se suben al bucket privado `fotos` con su ID como ruta y se bajan a demanda desde `resolvePhotoUrl`.
- **Antes de iniciar sesión no se encola nada.** Al primer ingreso se ofrece subir las fichas locales (`nubeOfrecerSubirLocales`).
- **Cambios de esquema:** nueva migración numerada en `supabase/migrations/` (nunca editar una ya aplicada en un municipio).

## PWA / Service Worker (detalles que no romper)
- El SW es un archivo real: **`sw.js`**. `CACHE_VERSION` actual: **`arborrisk-v8`** (constante arriba de `sw.js`). Estrategia: **network-first** en navegaciones (con timeout y fallback a caché) + **cache-first** en el resto del mismo origen. Mismo patrón que el `sw.js` de presupuestos.
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
Parsea el `CACHE_VERSION` de `sw.js`, así que no hay que tocarlo al subir la versión.

Test de punta a punta de la nube (necesita un proyecto Supabase **de prueba** y usuarios de prueba; ver `supabase/README.md`):
```bash
NUBE_RELEV1=email:pass NUBE_RELEV2=email:pass NUBE_CONSULTA=email:pass NUBE_PROXY="$HTTPS_PROXY" node test/nube.test.cjs
```

Test de comportamiento del catastro (XSS al consolidar, IDs inválidos, paginación, UUID, GPS/autoría, CSV/GeoJSON, catálogo de especies, vínculo árbol↔evaluación, conteo por árbol, migración y fotos consolidadas):
```bash
node test/catastro.test.cjs
``` _(La network policy del entorno puede bloquear cdnjs/OSM; por eso el test no depende de recursos externos.)_

## Cosas que NO romper
- No pasar el JS a módulos ES (rompería los `onclick` globales).
- No olvidar subir `CACHE_VERSION` en `sw.js` al desplegar.
- No volver a inyectar el SW inline desde `blob:` (no registra → sin offline).
- No mover los datos de IndexedDB a localStorage (riesgo de cuota y pérdida de fotos).
