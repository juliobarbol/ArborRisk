# ArborRisk — Nube (Supabase)

La app es **offline-first**: trabaja siempre contra IndexedDB y, si hay sesión
iniciada, sincroniza con un proyecto de Supabase. **Una instancia = un proyecto
de Supabase** (la demo, o un municipio).

## Qué hay en el servidor

`migrations/0001_arborrisk_sync.sql` crea todo:

| Objeto | Para qué |
|---|---|
| `perfiles` | Usuario → nombre, iniciales, **rol**. El **primer usuario que se registra queda como admin**; el resto entra como `pendiente` hasta que un admin le asigne un rol. |
| `fichas` | Una fila por ficha (registro o riesgo). La ficha completa va en `data` (jsonb); `code`, `especie`, `risk_level`, `arbol_id` y `geom` (PostGIS) se derivan por trigger. Borrado lógico con `deleted_at`. |
| `sync_push(jsonb)` | Única vía de escritura. Recibe lotes de hasta 200 cambios; resuelve conflictos por `updated_at` (gana el más reciente) y devuelve aceptados, conflictos y rechazados. |
| `asignar_rol`, `actualizar_mi_perfil` | Administración de usuarios desde la app. |
| bucket `fotos` | Privado. Ruta = ID de la foto. Máx. 5 MB, webp/jpeg/png. |

Roles: `admin` (todo + usuarios), `supervisor` (carga y borra cualquier ficha),
`relevador` (carga; borra solo lo propio), `consulta` (solo lectura),
`pendiente` (sin acceso).

Los usuarios con sesión **solo leen** tablas (RLS); toda escritura pasa por las
funciones `SECURITY DEFINER`, que validan el rol. Por eso el linter de Supabase
avisa que usuarios autenticados pueden ejecutarlas: es intencional.

## Crear una instancia nueva (otro municipio)

1. Crear un proyecto en Supabase (región `sa-east-1`, São Paulo).
2. Ejecutar `migrations/0001_arborrisk_sync.sql` (SQL Editor o CLI).
3. **Authentication → Sign In / Providers → Email**:
   - Para una **demo**: desactivar **Confirm email** (el correo integrado de
     Supabase solo envía a miembros del equipo del proyecto y tiene un límite
     muy bajo por hora).
   - Para **producción**: dejarlo activo y configurar un **SMTP propio**
     (Authentication → Emails → SMTP).
   - Una vez creados los usuarios del municipio, se puede desactivar
     **Allow new users to sign up** y dar de alta usuarios por invitación.
4. **El primero que crea su cuenta queda como administrador**: que lo haga la
   persona responsable del municipio (o vos, y después le pasás el rol).
5. En la app: menú **SYNC → ☁ Nube del equipo → Cambiar servidor** y cargar la
   URL y la clave publicable del proyecto (Settings → API Keys). Para una
   versión dedicada al municipio, cambiar `NUBE_DEFAULT` en `index.html`.

## Test de punta a punta

`test/nube.test.cjs` simula varios dispositivos contra un proyecto **de prueba**
(no usar el de un municipio: deja fichas de prueba borradas lógicamente).

Usuarios de prueba ya confirmados (SQL Editor, sin enviar emails). Si el proyecto
está vacío, **el primero queda como admin**: creá antes tu propia cuenta.

```sql
do $$
declare u record; v_id uuid;
begin
  for u in select * from (values ('t-relev1@arborrisk.test','Relevador Uno'),
                                 ('t-relev2@arborrisk.test','Relevador Dos'),
                                 ('t-consulta@arborrisk.test','Consulta')) t(email, nombre) loop
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
      email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', u.email,
      extensions.crypt('CAMBIAR-ESTA-CLAVE', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('nombre', u.nombre), now(), now(),
      '', '', '', '', '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now());
  end loop;
end $$;
update public.perfiles set rol = 'relevador' where email in ('t-relev1@arborrisk.test','t-relev2@arborrisk.test');
update public.perfiles set rol = 'consulta'  where email = 't-consulta@arborrisk.test';
```

```bash
NUBE_RELEV1='t-relev1@arborrisk.test:CAMBIAR-ESTA-CLAVE' \
NUBE_RELEV2='t-relev2@arborrisk.test:CAMBIAR-ESTA-CLAVE' \
NUBE_CONSULTA='t-consulta@arborrisk.test:CAMBIAR-ESTA-CLAVE' \
NUBE_PROXY="$HTTPS_PROXY" node test/nube.test.cjs
```

Limpieza:

```sql
delete from public.fichas where code ~ '-(E2E|OFF|LOC)-';
delete from auth.users where email like 't-%@arborrisk.test';
```

## Límites del plan gratuito (para demos)

El proyecto se **pausa tras ~1 semana sin uso**: reactivalo desde el panel antes
de una demo. Base de datos y almacenamiento de fotos limitados (alcanza para
cientos de árboles con fotos, no para un catastro completo). Verificá los
valores vigentes en la página de precios de Supabase.
