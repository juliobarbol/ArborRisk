-- ============================================================
-- ArborRisk — esquema de sincronización (Supabase / PostgreSQL)
-- ============================================================
-- Modelo: cada ficha de la app (registro o riesgo) es una fila de `fichas`.
-- La ficha completa viaja en `data` (jsonb); algunas columnas se derivan por
-- trigger para consultas y SIG (código, especie, riesgo, árbol, geometría).
--
-- Seguridad:
--   * Los usuarios autenticados SOLO LEEN tablas (según rol, vía RLS).
--   * Toda escritura pasa por funciones SECURITY DEFINER que validan el rol:
--       sync_push(), asignar_rol(), actualizar_mi_perfil().
--   * Roles: admin, supervisor, relevador, consulta, pendiente (sin acceso).
--   * El primer usuario que se registra en una instancia queda como admin.
--
-- Una instancia = un proyecto de Supabase = un municipio (o la demo).

create extension if not exists postgis with schema extensions;

-- ── Perfiles y roles ────────────────────────────────────────
create table public.perfiles (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  email     text,
  nombre    text not null default '',
  iniciales text not null default '',
  rol       text not null default 'pendiente'
            check (rol in ('admin', 'supervisor', 'relevador', 'consulta', 'pendiente')),
  creado_en timestamptz not null default now()
);
alter table public.perfiles enable row level security;

create or replace function public.mi_rol()
returns text
language sql stable security definer set search_path = ''
as $$
  select rol from public.perfiles where user_id = (select auth.uid())
$$;

-- Alta de usuario → perfil. El primero de la instancia es admin; el resto, pendiente.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(424242);
  insert into public.perfiles (user_id, email, nombre, rol)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'nombre', ''),
    case when exists (select 1 from public.perfiles where rol = 'admin') then 'pendiente' else 'admin' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Cada uno ve su perfil; admin y supervisor ven todos.
create policy perfiles_select on public.perfiles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.mi_rol()) in ('admin', 'supervisor'));

-- Solo admin cambia roles. No se puede dejar la instancia sin admin.
create or replace function public.asignar_rol(p_user_id uuid, p_rol text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if public.mi_rol() is distinct from 'admin' then
    raise exception 'Solo un administrador puede asignar roles' using errcode = '42501';
  end if;
  if p_rol not in ('admin', 'supervisor', 'relevador', 'consulta', 'pendiente') then
    raise exception 'Rol inválido: %', p_rol;
  end if;
  if p_rol <> 'admin'
     and exists (select 1 from public.perfiles where user_id = p_user_id and rol = 'admin')
     and (select count(*) from public.perfiles where rol = 'admin') = 1 then
    raise exception 'No se puede quitar el único administrador';
  end if;
  update public.perfiles set rol = p_rol where user_id = p_user_id;
end;
$$;

create or replace function public.actualizar_mi_perfil(p_nombre text, p_iniciales text)
returns void
language sql security definer set search_path = ''
as $$
  update public.perfiles
     set nombre = left(coalesce(p_nombre, ''), 120),
         iniciales = upper(left(regexp_replace(coalesce(p_iniciales, ''), '[^A-Za-z0-9]', '', 'g'), 4))
   where user_id = (select auth.uid());
$$;

-- ── Fichas ──────────────────────────────────────────────────
create table public.fichas (
  id                text primary key check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  tipo              text not null check (tipo in ('registro', 'riesgo')),
  code              text,
  arbol_id          text,
  especie           text,
  risk_level        text,
  geom              extensions.geography(Point, 4326),
  data              jsonb not null check (octet_length(data::text) < 300000),
  updated_at        timestamptz not null,               -- updatedAt del dispositivo (resuelve conflictos)
  server_updated_at timestamptz not null default clock_timestamp(),  -- cursor de descarga incremental
  deleted_at        timestamptz,                         -- borrado lógico (se propaga a otros dispositivos)
  created_by        uuid,
  updated_by        uuid
);
create index fichas_server_updated_idx on public.fichas (server_updated_at);
create index fichas_arbol_idx on public.fichas (arbol_id);
create index fichas_geom_idx on public.fichas using gist (geom);
alter table public.fichas enable row level security;

-- Columnas derivadas de `data` + marca de servidor
create or replace function public.fichas_derivar()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  m text[];
begin
  new.server_updated_at := clock_timestamp();
  new.code       := new.data ->> 'code';
  new.especie    := nullif(new.data ->> 'especie', '');
  new.risk_level := nullif(new.data ->> 'riskLevel', '');
  new.arbol_id   := nullif(new.data ->> 'arbolId', '');
  m := regexp_match(coalesce(new.data ->> 'gps', ''),
                    '^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$');
  if m is not null and abs(m[1]::float8) <= 90 and abs(m[2]::float8) <= 180 then
    new.geom := extensions.st_setsrid(extensions.st_makepoint(m[2]::float8, m[1]::float8), 4326)::extensions.geography;
  else
    new.geom := null;
  end if;
  return new;
end;
$$;

create trigger fichas_derivar_trg
  before insert or update on public.fichas
  for each row execute function public.fichas_derivar();

-- Lectura para cualquier rol con acceso
create policy fichas_select on public.fichas
  for select to authenticated
  using ((select public.mi_rol()) in ('admin', 'supervisor', 'relevador', 'consulta'));

-- Sin escritura directa: solo vía sync_push()
revoke insert, update, delete on public.fichas from anon, authenticated;
revoke insert, update, delete on public.perfiles from anon, authenticated;

-- ── sync_push: sube un lote de cambios ──────────────────────
-- Entrada: [{ id, tipo, data, updated_at, deleted }]
-- Regla de conflicto: gana el updated_at más reciente (last-write-wins por ficha).
-- Salida: { accepted: [id], conflicts: [fila del servidor], rejected: [{ id, motivo, server }] }
create or replace function public.sync_push(p_fichas jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rol      text := public.mi_rol();
  v_uid      uuid := (select auth.uid());
  f          jsonb;
  v_id       text;
  v_tipo     text;
  v_upd      timestamptz;
  v_del      boolean;
  cur        public.fichas%rowtype;
  accepted   jsonb := '[]'::jsonb;
  conflicts  jsonb := '[]'::jsonb;
  rejected   jsonb := '[]'::jsonb;
begin
  if v_rol is null or v_rol not in ('admin', 'supervisor', 'relevador') then
    raise exception 'Tu usuario no tiene permiso para cargar datos' using errcode = '42501';
  end if;
  if jsonb_typeof(p_fichas) <> 'array' or jsonb_array_length(p_fichas) > 200 then
    raise exception 'Lote inválido (máximo 200 fichas)';
  end if;

  for f in select * from jsonb_array_elements(p_fichas) loop
    v_id   := f ->> 'id';
    v_tipo := case when f ->> 'tipo' = 'registro' then 'registro' else 'riesgo' end;
    v_upd  := (f ->> 'updated_at')::timestamptz;
    v_del  := coalesce((f ->> 'deleted')::boolean, false);

    if v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,64}$' or v_upd is null then
      rejected := rejected || jsonb_build_object('id', v_id, 'motivo', 'ficha inválida');
      continue;
    end if;

    select * into cur from public.fichas where id = v_id for update;

    if not found then
      if v_del then
        accepted := accepted || to_jsonb(v_id);       -- nunca llegó al servidor: nada que borrar
        continue;
      end if;
      insert into public.fichas (id, tipo, data, updated_at, created_by, updated_by)
      values (v_id, v_tipo, f -> 'data', v_upd, v_uid, v_uid);
      accepted := accepted || to_jsonb(v_id);
      continue;
    end if;

    if v_upd < cur.updated_at then
      -- El servidor tiene una versión más nueva: gana el servidor
      conflicts := conflicts || jsonb_build_object('id', cur.id, 'tipo', cur.tipo, 'data', cur.data,
        'updated_at', cur.updated_at, 'deleted_at', cur.deleted_at);
      continue;
    end if;

    if v_del then
      -- Un relevador solo borra lo que cargó; admin y supervisor, cualquier ficha
      if v_rol = 'relevador' and cur.created_by is distinct from v_uid then
        rejected := rejected || jsonb_build_object('id', cur.id, 'motivo', 'sin permiso para borrar',
          'server', jsonb_build_object('id', cur.id, 'tipo', cur.tipo, 'data', cur.data,
            'updated_at', cur.updated_at, 'deleted_at', cur.deleted_at));
        continue;
      end if;
      update public.fichas
         set deleted_at = now(), updated_at = v_upd, updated_by = v_uid
       where id = v_id;
    else
      update public.fichas
         set data = f -> 'data', tipo = v_tipo, updated_at = v_upd, deleted_at = null, updated_by = v_uid
       where id = v_id;
    end if;
    accepted := accepted || to_jsonb(v_id);
  end loop;

  return jsonb_build_object('accepted', accepted, 'conflicts', conflicts, 'rejected', rejected);
end;
$$;

revoke execute on function public.sync_push(jsonb) from public, anon;
revoke execute on function public.asignar_rol(uuid, text) from public, anon;
revoke execute on function public.actualizar_mi_perfil(text, text) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.sync_push(jsonb) to authenticated;
grant execute on function public.asignar_rol(uuid, text) to authenticated;
grant execute on function public.actualizar_mi_perfil(text, text) to authenticated;

-- ── Fotos (Storage) ─────────────────────────────────────────
-- Bucket privado. Ruta = ID de la foto ("photo_<ts>_<rand>"). Las fotos no se
-- sobrescriben (mismo ID = misma foto), por eso no hay política de update.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy fotos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'fotos' and (select public.mi_rol()) in ('admin', 'supervisor', 'relevador', 'consulta'));

create policy fotos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fotos'
              and (select public.mi_rol()) in ('admin', 'supervisor', 'relevador')
              and name ~ '^photo_[A-Za-z0-9_]{1,60}$');

-- mi_rol() solo la usan usuarios autenticados (políticas RLS)
revoke execute on function public.mi_rol() from public, anon;
grant execute on function public.mi_rol() to authenticated;
