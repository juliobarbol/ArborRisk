-- schema.sql — Esquema Supabase para ArborRisk (Fase 2: sync en tiempo real)
--
-- FUENTE DE VERDAD del esquema que la app espera. Correrlo una vez en el
-- SQL Editor del proyecto Supabase de ArborRisk. Es idempotente
-- (create … if not exists / drop policy if exists), se puede re-correr.
--
-- IDEA CENTRAL: cada ficha pertenece a un PROYECTO (= municipalidad /
-- localidad / cliente institucional). El proyecto es el namespace que aísla
-- los datos: un inspector de la Muni A nunca ve ni toca las fichas de la
-- Muni B. El aislamiento es REAL (RLS por rol), no cosmético: sin sesión
-- iniciada, auth.uid() es null → arbor_role() devuelve null → no se ve nada.
--
-- Conflictos entre dispositivos: gana el de updated_at más reciente (mismo
-- criterio que el merge manual que ya hace la app). Los borrados viajan como
-- "tombstones" (deleted = true), no como DELETE físico, para que se propaguen.

-- ════════════════════════════════════════════════════════════════════
-- proyectos — catálogo de proyectos / municipalidades
--   Alta administrativa (service role). Los miembros solo lo LEEN.
-- ════════════════════════════════════════════════════════════════════
create table if not exists proyectos (
  id          text primary key,            -- slug estable, ej. 'muni-tigre'
  nombre      text not null,               -- visible, ej. 'Municipalidad de Tigre'
  created_at  timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════
-- user_proyectos — membresía persona ↔ proyecto + rol
--   Una persona puede pertenecer a varios proyectos. Alta administrativa.
--   role: 'editor' (carga/edita/borra fichas) | 'lector' (solo lee).
-- ════════════════════════════════════════════════════════════════════
create table if not exists user_proyectos (
  user_id     uuid not null references auth.users(id) on delete cascade,
  proyecto    text not null references proyectos(id)  on delete cascade,
  role        text not null default 'editor' check (role in ('editor','lector')),
  inspector   text,                        -- nombre fijo del inspector (opcional)
  iniciales   text,                        -- prefijo de códigos (opcional)
  created_at  timestamptz not null default now(),
  primary key (user_id, proyecto)
);

-- ════════════════════════════════════════════════════════════════════
-- fichas — el registro de árbol sincronizado (1 fila por ficha y proyecto)
--   payload = la ficha SIN las fotos pesadas (las fotos van a Storage).
--   PK compuesta (proyecto, id): el id es el id local de la ficha.
-- ════════════════════════════════════════════════════════════════════
create table if not exists fichas (
  proyecto    text not null references proyectos(id) on delete cascade,
  id          text not null,               -- id local de la ficha (records[i].id)
  payload     jsonb not null,              -- ficha completa con photos como IDs
  updated_at  timestamptz not null default now(),  -- = records[i].updatedAt
  deleted     boolean not null default false,      -- tombstone (borrado lógico)
  device_id   text,                        -- arborrisk_device_id de origen
  inspector   text,                        -- nombre del inspector que editó
  inspector_uid uuid default auth.uid(),   -- quién hizo el último cambio
  primary key (proyecto, id)
);

-- Pull incremental por proyecto (traer solo lo cambiado desde la última vez)
create index if not exists fichas_proyecto_updated_idx on fichas (proyecto, updated_at desc);

-- ── Realtime: la app escucha cambios de fichas filtrando por proyecto ──
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fichas'
  ) then
    alter publication supabase_realtime add table fichas;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- AUTH + RLS
--   Cada persona tiene un usuario de Supabase Auth (email + contraseña) y
--   una o más filas en user_proyectos. Las policies consultan el rol con el
--   helper arbor_role(proyecto). Sin sesión → null → acceso cero.
-- ════════════════════════════════════════════════════════════════════

alter table proyectos      enable row level security;
alter table user_proyectos enable row level security;
alter table fichas         enable row level security;

-- user_proyectos: la lee el helper (security definer). No la exponemos por RLS
-- a la anon/anon key; solo la propia membresía es legible por el usuario.
revoke all on user_proyectos from anon, authenticated;
grant select on user_proyectos to authenticated;
drop policy if exists user_proyectos_self on user_proyectos;
create policy user_proyectos_self on user_proyectos
  for select to authenticated using (user_id = auth.uid());

-- Helper de rol: SECURITY DEFINER para leer user_proyectos sin exponerla.
create or replace function public.arbor_role(p_proyecto text)
returns text language sql stable security definer set search_path = public as
$$ select role from user_proyectos where user_id = auth.uid() and proyecto = p_proyecto $$;

-- proyectos: un usuario solo ve los proyectos a los que pertenece.
drop policy if exists proyectos_read on proyectos;
create policy proyectos_read on proyectos
  for select to authenticated using (arbor_role(id) is not null);

-- fichas: leer si sos miembro; escribir/borrar (tombstone) si sos editor.
drop policy if exists fichas_read   on fichas;
drop policy if exists fichas_insert on fichas;
drop policy if exists fichas_update on fichas;
drop policy if exists fichas_delete on fichas;
create policy fichas_read   on fichas for select to authenticated
  using (arbor_role(proyecto) is not null);
create policy fichas_insert on fichas for insert to authenticated
  with check (arbor_role(proyecto) = 'editor');
create policy fichas_update on fichas for update to authenticated
  using (arbor_role(proyecto) = 'editor') with check (arbor_role(proyecto) = 'editor');
create policy fichas_delete on fichas for delete to authenticated
  using (arbor_role(proyecto) = 'editor');

-- ════════════════════════════════════════════════════════════════════
-- STORAGE — bucket privado de fotos, una "carpeta" por proyecto
--   path: '{proyecto}/{photoId}.jpg'  → (storage.foldername(name))[1] = proyecto
-- ════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
  values ('fichas-fotos', 'fichas-fotos', false)
  on conflict (id) do nothing;

drop policy if exists "fotos read"   on storage.objects;
drop policy if exists "fotos insert" on storage.objects;
drop policy if exists "fotos delete" on storage.objects;
create policy "fotos read" on storage.objects for select to authenticated
  using (bucket_id = 'fichas-fotos' and arbor_role((storage.foldername(name))[1]) is not null);
create policy "fotos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'fichas-fotos' and arbor_role((storage.foldername(name))[1]) = 'editor');
create policy "fotos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'fichas-fotos' and arbor_role((storage.foldername(name))[1]) = 'editor');

-- ════════════════════════════════════════════════════════════════════
-- ALTA / BAJA DE PERSONAS Y PROYECTOS (administrativo, service role)
--   1) Crear el proyecto (una vez por municipalidad):
--        insert into proyectos(id, nombre)
--          values ('muni-tigre', 'Municipalidad de Tigre')
--          on conflict (id) do nothing;
--   2) Crear el usuario en Supabase Auth (Dashboard → Authentication, o
--      Admin API con SUPABASE_ACCESS_TOKEN): email + contraseña.
--   3) Asociarlo al proyecto con su rol:
--        insert into user_proyectos(user_id, proyecto, role, inspector, iniciales)
--          values ('<uuid-del-usuario>', 'muni-tigre', 'editor', 'Juan Pérez', 'JP')
--          on conflict (user_id, proyecto) do update
--            set role = excluded.role, inspector = excluded.inspector, iniciales = excluded.iniciales;
--   Baja: borrar el usuario de Auth → user_proyectos cae solo (ON DELETE CASCADE)
--         → el teléfono queda sin acceso al instante.
-- ════════════════════════════════════════════════════════════════════
