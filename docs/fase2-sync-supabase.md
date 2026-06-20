# Fase 2 — Sincronización en tiempo real (Supabase)

> Diseño detallado del sync multi-proyecto para ArborRisk. La Fase 1 (backup
> a Google Drive) ya está hecha; esta fase es independiente y **opt-in**: sin
> nube configurada ni sesión iniciada, la app funciona exactamente como hoy
> (offline-first, sin login). El esquema de base vive en `schema.sql`.

## Objetivo

Que varios inspectores de un **mismo proyecto** (una municipalidad, una
localidad, un cliente institucional) vean y editen las **mismas fichas en
tiempo real**, y que los datos **nunca se mezclen** entre proyectos distintos.

El "proyecto" es el **namespace** que aísla todo (equivalente al `ns` de
StockMerger). Cada persona pertenece a uno o más proyectos con un rol
(`editor` / `lector`), y la base **solo le deja ver/tocar lo de sus proyectos**
mediante RLS real (no es cosmético: sin sesión no se ve nada).

## Por qué encaja con la filosofía de ArborRisk

La app **ya tiene el 80% del modelo**:

- Cada ficha tiene `id` estable + `updatedAt` (ISO). El sync usa ese timestamp.
- Ya existe `mergeImportData()` con **last-write-wins por `updatedAt`**
  (agregados / actualizados / sin cambios / conflictos). El sync en tiempo real
  **reusa esa misma lógica**: en vez de leerla de un archivo, la recibe de la
  nube.
- Ya existe el concepto de inspector + `proyecto` (`arborrisk_config`) y un
  `arborrisk_device_id` persistente.
- Las fotos ya viven en IndexedDB referenciadas por ID; acá solo agregamos
  subirlas/bajarlas de Supabase Storage.

Se mantiene: vanilla JS, un solo `index.html`, ámbito global, sin build,
offline-first. El sync es una capa nueva que **no toca el flujo offline**.

## Modelo de datos (ver `schema.sql`)

| Tabla | Rol |
|---|---|
| `proyectos` | Catálogo de municipalidades/proyectos. Alta administrativa. |
| `user_proyectos` | Membresía persona ↔ proyecto + rol (`editor`/`lector`). |
| `fichas` | 1 fila por ficha y proyecto. `payload` (jsonb, ficha con fotos como IDs), `updated_at`, `deleted` (tombstone), `device_id`, `inspector`. PK `(proyecto, id)`. |
| Storage `fichas-fotos` | Bucket privado. Path `{proyecto}/{photoId}.jpg`. RLS por membresía. |

**Por qué las fotos van a Storage y no embebidas en el payload:** un árbol
puede tener varias fotos y un proyecto miles de fichas; meter MB de base64 en
cada fila/realtime sería carísimo en datos móviles. El payload guarda solo los
IDs (como ya hace la app localmente) y un sync aparte sube/baja los binarios.

## RLS (aislamiento entre proyectos)

- Helper `arbor_role(proyecto)` (SECURITY DEFINER) devuelve el rol de
  `auth.uid()` en ese proyecto, o `null` si no es miembro.
- `fichas`: **SELECT** si sos miembro; **INSERT/UPDATE/DELETE** si sos `editor`.
- `proyectos`: solo ves los tuyos. `user_proyectos`: solo ves tu propia membresía.
- Storage: misma regla, leyendo el proyecto del primer segmento del path.
- Sin sesión (`auth.uid()` null) → todo `null` → **acceso cero**. Ese es el
  aislamiento entre municipalidades.

## Arquitectura del lado de la app (a implementar: `js/supabase.js`)

Nueva sección `/* js/supabase.js */`, inerte hasta configurar la nube. Patrón
calcado de StockMerger (`SUPABASE.JS`), adaptado a fichas.

### Configuración e inicio de sesión

- **Config** en `localStorage['arborrisk_sb_config'] = { url, anonKey }`
  (la pega el dueño una vez; la Site del proyecto Supabase). Cliente con
  `supabase.createClient(url, anonKey, { auth:{ persistSession:true,
  autoRefreshToken:true, storageKey:'arborrisk_sb_auth' }})`.
- **Login opt-in:** el inspector inicia sesión UNA vez con el email/contraseña
  de su municipalidad (`signInWithPassword`). La sesión persiste y se renueva
  sola; offline el token vencido se renueva al recuperar internet.
- **Proyecto activo:** tras login, `select * from proyectos` (RLS ya filtra).
  Si pertenece a uno solo, se elige solo; si a varios, un selector. Se guarda
  en `localStorage['arborrisk_sb_proyecto']`.
- **Sin nube / sin sesión:** la app trabaja 100% local como hoy. El login NO
  bloquea el uso de campo; solo habilita el sync. (No replicamos el `authGate`
  bloqueante de StockMerger: acá el login es voluntario por dispositivo.)

### Subida (push)

- Al guardar una ficha (`dbPut` → `_afterDataChange`): si hay sesión + proyecto,
  `scheduleSupabasePush()` (debounce corto, ~5 s, respetando `navigator.onLine`)
  hace `upsert` a `fichas` con `{ proyecto, id, payload, updated_at: r.updatedAt,
  device_id, inspector }`. Las **fotos nuevas** se suben al bucket
  (`{proyecto}/{photoId}.jpg`) si aún no existen.
- Al borrar (`dbDelete`): upsert con `deleted = true` y `updated_at = now`
  (tombstone), para que el borrado se propague a los demás.
- Cola offline: si no hay señal, queda pendiente y se sube en `online` /
  `visibilitychange` (misma mecánica que el auto-backup a Drive).

### Bajada (pull) + Realtime

- **Pull inicial** al iniciar sesión / abrir con sesión:
  `select * from fichas where proyecto = ? and updated_at > lastPull`.
  Cada fila entrante pasa por la **misma reconciliación que `mergeImportData`**:
  - tombstone (`deleted`) → borrar la ficha local (si existe);
  - `updated_at` entrante > local → aplicar (dbPut + bajar fotos faltantes a IDB);
  - igual o menor → ignorar (gana el local).
  Se guarda `lastPull` en `localStorage['arborrisk_sb_lastpull_<proyecto>']`.
- **Realtime:** `channel().on('postgres_changes', { event:'*', schema:'public',
  table:'fichas', filter:'proyecto=eq.<proyecto>' }, …)` → cada cambio aplica la
  misma reconciliación. Así un inspector ve aparecer en segundos la ficha que
  cargó un compañero.
- **Fotos:** al aplicar una ficha entrante, para cada `photoId` que no esté en
  IDB se baja de Storage y se guarda con `dbPutPhoto(id, blob)`. La descarga es
  perezosa/en segundo plano para no trabar la UI.

### Reconciliación (reusar lo existente)

Extraer de `mergeImportData()` una función pura
`reconcileIncomingRecord(inc)` (sin DOM) que aplique last-write-wins +
tombstones, y llamarla tanto desde el merge manual como desde pull/realtime.
Así hay **una sola** regla de conflictos en toda la app.

### Claves de localStorage nuevas

`arborrisk_sb_config`, `arborrisk_sb_auth` (la maneja supabase-js),
`arborrisk_sb_proyecto`, `arborrisk_sb_lastpull_<proyecto>`. Ninguna pisa las
existentes.

### UI

En el modal de Sincronización (`#sync-modal`), una sección "☁️ Nube del
proyecto" (oculta hasta configurar la nube), con: estado de conexión, login/
logout, proyecto activo y un indicador "Sincronizado ✓ / Pendiente". Misma
estética que la sección de Drive.

### Service Worker / CDN

supabase-js se carga por CDN (jsdelivr, igual que StockMerger). Sumar el host a
`CDN_HOSTS` en `sw.js` para que quede offline tras la primera carga. Subir
`CACHE_VERSION`. La librería es **solo-online** para sync, pero cachearla evita
errores de carga offline.

## Decisiones abiertas (a confirmar antes de implementar)

1. **Fotos por datos móviles:** ¿subir/bajar siempre, o agregar opción "solo
   con WiFi"? (Sugerencia: v1 sube siempre en segundo plano; opción WiFi después.)
2. **Rol `lector`:** ¿lo necesitamos ya (ej. un supervisor municipal que solo
   mira) o arrancamos solo con `editor`? El esquema ya lo soporta.
3. **Captcha en login (Turnstile):** StockMerger lo tiene. Para ArborRisk se
   puede agregar igual; lo dejo fuera de v1 salvo que lo quieras.
4. **Borrados:** confirmamos tombstones (un borrado se propaga a todos). Si se
   prefiere que cada quien borre solo en su teléfono, se quita el push de
   `deleted`.

## Pasos de implementación (cuando arranquemos)

1. Crear el proyecto Supabase y correr `schema.sql`.
2. `js/supabase.js`: config, login, selector de proyecto, push, pull, realtime,
   sync de fotos (Storage), UI en el modal.
3. Extraer `reconcileIncomingRecord()` desde `mergeImportData()`.
4. `sw.js`: host de supabase-js en `CDN_HOSTS` + `CACHE_VERSION` nueva.
5. Verificar: sintaxis JS + `test/pwa.test.cjs`. Alta de un proyecto de prueba
   con dos usuarios y validar realtime + aislamiento entre dos proyectos.
