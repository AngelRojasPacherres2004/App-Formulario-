-- Esquema base para la versión actual de la app
-- Pensado para una base nueva en Supabase.

create table if not exists public.usuarios (
  id bigserial primary key,
  nombre text not null,
  email text not null unique,
  password_hash text not null, -- almacena la contraseña literal
  rol text not null check (rol in ('administrador', 'operante', 'jefe de equipo', 'jefe de grupo', 'otros')),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  fecha_cumpleanos date,
  sueldo numeric(12,2) not null default 0
    check (sueldo >= 0)
);

create table if not exists public.tarea (
  id bigserial primary key,
  titulo text not null,
  descripcion text,
  estado text not null default 'pendiente',
  tipo_medicion text not null default 'cantidad'
    check (tipo_medicion in ('cantidad', 'cumplimiento', 'tiempo', 'turno')),
  unidad_base text,
  requiere_marca boolean not null default false,
  puntaje_fijo integer,
  puntaje_turno_simple integer,
  puntaje_turno_completo integer,
  asignado_a bigint references public.usuarios(id) on delete set null,
  email_trabajador text,
  created_at timestamptz not null default now()
);

create index if not exists idx_tarea_asignado_a
  on public.tarea(asignado_a);

create index if not exists idx_tarea_estado
  on public.tarea(estado);

create table if not exists public.rangos_puntaje (
  id bigserial primary key,
  tarea_id bigint not null references public.tarea(id) on delete cascade,
  cantidad_desde numeric not null,
  cantidad_hasta numeric,
  puntos integer not null check (puntos between 1 and 10),
  created_at timestamptz not null default now(),
  constraint chk_rangos_puntaje_hasta
    check (cantidad_hasta is null or cantidad_hasta >= cantidad_desde)
);

create unique index if not exists idx_rangos_puntaje_tarea_range
  on public.rangos_puntaje(tarea_id, cantidad_desde, cantidad_hasta);

create index if not exists idx_rangos_puntaje_tarea_id
  on public.rangos_puntaje(tarea_id);

create table if not exists public.registro_actividades (
  id bigserial primary key,
  trabajador_id bigint not null references public.usuarios(id) on delete cascade,
  tarea_id bigint not null references public.tarea(id) on delete cascade,
  actividad_nombre text,
  fecha_registro date not null default current_date,
  cantidad numeric,
  tiempo_minutos integer,
  cumplimiento boolean,
  detalle text,
  turno text,
  puntos_obtenidos numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_registro_actividades_trabajador_fecha
  on public.registro_actividades(trabajador_id, fecha_registro desc);

create index if not exists idx_registro_actividades_tarea_id
  on public.registro_actividades(tarea_id);

create table if not exists public.asistencias (
  id bigserial primary key,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  fecha date not null,
  estado varchar(20) not null default 'AUSENTE' check (estado in ('AUSENTE', 'PUNTUAL', 'TARDANZA')),
  created_at timestamp default current_timestamp,
  constraint uq_asistencia unique (usuario_id, fecha)
);

create table if not exists public.tiendas (
  id bigserial primary key,
  nombre text not null unique,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.incidentes (
  id bigserial primary key,
  turno text not null check (turno in ('turno regular', 'incidencia', 'turno extra')),
  nombre text not null,
  tarea_id bigint references public.tarea(id) on delete set null,
  tarea_nombre text,
  tienda_id bigint references public.tiendas(id) on delete set null,
  numero_guia text,
  observacion text,
  tipo_error text not null check (tipo_error in ('CONTENIDO', 'LIBERADO')),
  created_by bigint references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_incidentes_tienda_id on public.incidentes(tienda_id);
create index if not exists idx_incidentes_tarea_id on public.incidentes(tarea_id);
create index if not exists idx_incidentes_created_at on public.incidentes(created_at desc);

create table if not exists public.amonestaciones (
  id bigserial primary key,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  descripcion text not null,
  created_by bigint references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_amonestaciones_usuario_id on public.amonestaciones(usuario_id);
create index if not exists idx_amonestaciones_created_at on public.amonestaciones(created_at desc);

create table if not exists public.registros_jefe_grupo (
  id bigserial primary key,
  encargado_id bigint not null references public.usuarios(id) on delete restrict,
  trabajador_id bigint not null references public.usuarios(id) on delete restrict,
  tarea_id bigint not null references public.tarea(id) on delete restrict,
  tarea_nombre text,
  fecha_registro date not null default current_date,
  cantidad numeric,
  tiempo_minutos integer,
  codigo_guia text,
  lote text,
  detalle text,
  created_at timestamptz not null default now(),
  constraint chk_registro_jefe_grupo_valor
    check (
      cantidad is not null
      or tiempo_minutos is not null
      or codigo_guia is not null
      or detalle is not null
    )
);

create index if not exists idx_registros_jefe_grupo_encargado
  on public.registros_jefe_grupo(encargado_id, created_at desc);

create index if not exists idx_registros_jefe_grupo_trabajador
  on public.registros_jefe_grupo(trabajador_id, created_at desc);

create index if not exists idx_registros_jefe_grupo_tarea
  on public.registros_jefe_grupo(tarea_id);

create or replace view public.v_registros_jefe_grupo as
select
  r.id,
  r.encargado_id,
  encargado.nombre as encargado_nombre,
  encargado.email as encargado_email,
  r.trabajador_id,
  trabajador.nombre as trabajador_nombre,
  trabajador.email as trabajador_email,
  r.tarea_id,
  coalesce(r.tarea_nombre, t.titulo, ('Tarea ' || r.tarea_id::text)) as tarea_nombre,
  r.fecha_registro,
  r.cantidad,
  r.tiempo_minutos,
  r.codigo_guia,
  r.lote,
  r.detalle,
  r.created_at
from public.registros_jefe_grupo r
join public.usuarios encargado on encargado.id = r.encargado_id
join public.usuarios trabajador on trabajador.id = r.trabajador_id
left join public.tarea t on t.id = r.tarea_id;

create or replace function public.verify_usuario_login(
  p_email text,
  p_password text
)
returns table (
  id bigint,
  nombre text,
  email text,
  rol text,
  activo boolean,
  created_at timestamptz,
  fecha_cumpleanos date
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    u.id,
    u.nombre,
    u.email,
    u.rol,
    u.activo,
    u.created_at,
    u.fecha_cumpleanos
  from public.usuarios u
  where lower(trim(u.email)) = lower(trim(p_email))
    and u.password_hash = p_password
  limit 1;
end;
$$;

revoke all on function public.verify_usuario_login(text, text) from public;
grant execute on function public.verify_usuario_login(text, text) to anon;
grant execute on function public.verify_usuario_login(text, text) to authenticated;
