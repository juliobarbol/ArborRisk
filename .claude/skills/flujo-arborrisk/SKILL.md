---
name: flujo-arborrisk
description: Forma de trabajar con ArborRisk (app de riesgo biomecánico de árboles de Julio). Usar SIEMPRE que haya que implementar, arreglar, mejorar o publicar algo en esta app. Define el flujo completo - implementar de forma autónoma, mergear directo a main, verificar el deploy y reportar en lenguaje simple (Julio no es programador y no tiene entorno de pruebas).
---

# Flujo de trabajo — ArborRisk

## Quién es el usuario

Julio **no es programador** y **no tiene entorno de pruebas**: la única forma
que tiene de probar algo es abrir la app ya publicada en su celular o PC.
Esto define todo el flujo:

- Vos sos el único control de calidad antes de publicar.
- Las explicaciones tienen que estar en castellano simple, sin jerga técnica.

## Autonomía: hacé todo lo que puedas vos

Tenés autorización permanente de Julio para:

1. Implementar el cambio completo.
2. Commitear con mensajes claros.
3. **`CACHE_VERSION` se estampa solo**: el workflow `.github/workflows/stamp-sw.yml` corre `build.py`
   en cada push a `main` y lo actualiza automáticamente. No hace falta bump manual.
4. **Mergear directo a `main` y pushear**, sin preguntar y sin crear PRs
   (PR solo si Julio lo pide explícitamente).
5. Si un push falla por red, reintentar hasta 4 veces con espera creciente
   (2s, 4s, 8s, 16s).

No dejes trabajo sin publicar ni termines con "¿querés que lo suba?": subilo.
Pará a preguntar SOLO si hay que elegir entre opciones que cambian lo que ve
el usuario final, o si el cambio puede afectar datos ya guardados (fichas,
fotos, backups).

## Cómo implementar (calidad sin tests)

No hay tests automáticos de funcionalidad, linters ni servidor local.
El control de calidad sos vos:

1. Seguí las reglas de lectura por rangos del CLAUDE.md ANTES de tocar
   `index.html` (son ~7.000 líneas; nunca leerlo entero).
2. Antes de mergear, releé el diff completo (`git diff main`) buscando
   errores de sintaxis o llaves sin cerrar — un error de JS deja la app
   entera en blanco para todos los usuarios.
3. Verificá la sintaxis JS con el comando del CLAUDE.md (extrae los scripts y
   corre `node --check`) antes de mergear.
4. Cambios visuales: no podés verlos corriendo la app en esta sesión; sé
   conservador y no reestructures más de lo pedido.

## Versionado del cache: automático

Al hacer push a `main`, el workflow `.github/workflows/stamp-sw.yml` corre
`build.py` y reescribe `const CACHE_VERSION` en `sw.js` con un timestamp.
**No hace falta hacer nada a mano.** Si el sw.js ya venía estampado, el
workflow no commitea nada (es idempotente).

Verificación post-merge: después de ~1–2 minutos podés hacer `git pull` y
confirmar que `CACHE_VERSION` tiene el timestamp del último push.

### Si el repo no tiene el estampado automático todavía

Chequeá al inicio de la sesión:

```bash
ls build.py .github/workflows/stamp-sw.yml 2>/dev/null
```

Si alguno falta, agregalo **junto con el primer cambio** que vayas a publicar
(no hace falta una sesión aparte). Los archivos a crear son:

- **`build.py`**: busca `const CACHE_VERSION = '...';` en `sw.js` y lo
  reemplaza con `<nombre-app>-<timestamp UTC>`. El nombre sale de
  `wrangler.jsonc`. Modelo en StockMerger/ArborRisk.
- **`.github/workflows/stamp-sw.yml`**: corre `build.py` en cada push a
  `main` y commitea si cambió. Guard `[skip stamp]` en el mensaje evita
  loops. Modelo en StockMerger/ArborRisk.
- **`.assetsignore`** (si no existe): excluir `build.py`, `CLAUDE.md`,
  `wrangler.jsonc` para que no se publiquen en Cloudflare.

Una vez que existe el workflow, nunca más hace falta acordarse de subir
la versión a mano.

## Después de mergear

1. Decile a Julio qué mirar en la app publicada para confirmar que el cambio
   funciona (1 o 2 pasos concretos, ej.: "abrí la app, entrá a una ficha y
   fijate que ahora el botón dice 'Guardar PDF'"). Es la única prueba real.
2. Aclarale que puede tardar 1–2 minutos en llegar al teléfono (Cloudflare
   demora un poco).
3. Si Julio pide varios cambios en un mensaje, implementalos TODOS y
   publicalos en una sola tanda — un solo ciclo de commit + bump de CACHE_VERSION
   + merge + verificación. No un ciclo por cambio.

## Cómo hablarle a Julio

- **Reportes CORTOS** (pedido explícito para ahorrar tokens): qué cambió en
  palabras de usuario + 1 o 2 pasos para probarlo. Apuntá a 3–6 líneas en
  total. Contexto técnico o advertencias SOLO si hay un riesgo real que Julio
  deba conocer.
- Castellano simple, sin jerga. Nada de "commit", "merge", "branch", "PWA",
  "service worker", "IndexedDB", "cache". Si un término técnico es inevitable,
  explicalo con una comparación cotidiana.
- Empezá siempre por el resultado: qué cambió en la app ("ahora el botón de
  exportar genera el PDF con el logo del profesional").
- Para él, mergear a main = publicar: decí "ya está publicado, en uno o dos
  minutos llega al teléfono" en vez de hablar de ramas.
- Nunca le pidas que corra comandos, tests o herramientas de programador.
- Detalles de código solo si los pide.

## Decisiones de producto

Las reglas que definió Julio (niveles de riesgo, esquema de fichas, fotos
en IndexedDB, sin login, etc.) están en la sección **"Decisiones de producto"**
del `CLAUDE.md`. Leelas antes de tocar esas áreas, y si Julio cambia alguna,
**editá esa sección del CLAUDE.md en el mismo cambio** para que no queden
reglas viejas que generen confusión en futuras sesiones.
