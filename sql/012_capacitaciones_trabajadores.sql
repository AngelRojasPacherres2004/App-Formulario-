-- Catalogo ordenado de capacitaciones y progreso individual por trabajador.
-- La secuencia se valida tambien en la base de datos.

begin;

-- Esta definicion conserva compatibilidad con una tabla capacitaciones anterior
-- que ya usaba id, curso, competencia, numero_horas, inversion y descripcion.
create table if not exists public.capacitaciones (
  id bigserial primary key,
  curso text,
  competencia text,
  numero_horas numeric,
  inversion numeric not null default 0,
  descripcion text,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.capacitaciones
  add column if not exists id_curso text,
  add column if not exists orden smallint,
  add column if not exists nombre_curso text,
  add column if not exists competencias text,
  add column if not exists nro_horas text,
  add column if not exists inversion_curso text;

insert into public.capacitaciones (
  id,
  curso,
  competencia,
  numero_horas,
  inversion,
  descripcion,
  activo,
  id_curso,
  orden,
  nombre_curso,
  competencias,
  nro_horas,
  inversion_curso
)
values
  (1, 'Inducción general (cultura y empresa)', 'OBLIGATORIO', 1, 0, 'Responsable: RRHH', true, 'CAP 1', 1, 'Inducción general (cultura y empresa)', 'OBLIGATORIO', '1 Hora', 'RRHH'),
  (2, 'Capacitación del puesto (técnica y operativa)', 'OBLIGATORIO', null, 0, 'Responsable: RRHH | Duración: 1 Mes', true, 'CAP 2', 2, 'Capacitación del puesto (técnica y operativa)', 'OBLIGATORIO', '1 Mes', 'RRHH'),
  (3, 'Seguridad y salud en el trabajo (SST)', 'OBLIGATORIO', 1, 0, 'Responsable: RRHH', true, 'CAP 3', 3, 'Seguridad y salud en el trabajo (SST)', 'OBLIGATORIO', '1 Hora', 'RRHH'),
  (4, 'Capacitación de seguridad y protección de datos', 'OBLIGATORIO', 1, 0, 'Responsable: RRHH', true, 'CAP 4', 4, 'Capacitación de seguridad y protección de datos', 'OBLIGATORIO', '1 Hora', 'RRHH'),
  (5, 'Habilidades blandas', 'OBLIGATORIO', 1, 0, 'Responsable: RRHH', true, 'CAP 5', 5, 'Habilidades blandas', 'OBLIGATORIO', '1 Hora', 'RRHH'),
  (6, 'Calidad y metodología 5S', 'OBLIGATORIO', 1, 0, 'Responsable: RRHH', true, 'CAP 6', 6, 'Calidad y metodología 5S', 'OBLIGATORIO', '1 Hora', 'RRHH'),
  (7, 'Manejo de Almacén y Gestión de Inventarios', 'OBLIGATORIO', 2, 0, 'Responsable: RRHH', true, 'CAP 7', 7, 'Manejo de Almacén y Gestión de Inventarios', 'OBLIGATORIO', '2 Hora', 'RRHH')
on conflict (id) do update set
  curso = excluded.curso,
  competencia = excluded.competencia,
  numero_horas = excluded.numero_horas,
  inversion = excluded.inversion,
  descripcion = excluded.descripcion,
  activo = true,
  id_curso = excluded.id_curso,
  orden = excluded.orden,
  nombre_curso = excluded.nombre_curso,
  competencias = excluded.competencias,
  nro_horas = excluded.nro_horas,
  inversion_curso = excluded.inversion_curso;

update public.capacitaciones
set
  id_curso = coalesce(id_curso, 'CAP ' || id::text),
  orden = coalesce(orden, id::smallint),
  nombre_curso = coalesce(nombre_curso, curso, 'Capacitación ' || id::text),
  competencias = coalesce(competencias, competencia, 'OBLIGATORIO'),
  nro_horas = coalesce(nro_horas, case when numero_horas is null then 'Sin duración' else numero_horas::text || ' Hora' end),
  inversion_curso = coalesce(inversion_curso, 'RRHH');

alter table public.capacitaciones
  alter column id_curso set not null,
  alter column orden set not null,
  alter column nombre_curso set not null,
  alter column competencias set not null,
  alter column nro_horas set not null,
  alter column inversion_curso set not null;

create unique index if not exists uq_capacitaciones_id_curso
  on public.capacitaciones(id_curso);

create unique index if not exists uq_capacitaciones_orden
  on public.capacitaciones(orden);

do $$
declare
  sequence_name text;
begin
  sequence_name := pg_get_serial_sequence('public.capacitaciones', 'id');
  if sequence_name is not null then
    perform setval(sequence_name, greatest((select coalesce(max(id), 1) from public.capacitaciones), 1));
  end if;
end $$;

create table if not exists public.usuario_capacitaciones (
  id bigserial primary key,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  curso_id text not null references public.capacitaciones(id_curso) on delete restrict,
  completado boolean not null default false,
  completado_en timestamptz,
  completado_por bigint references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_usuario_capacitacion unique (usuario_id, curso_id),
  constraint capacitacion_fecha_coherente check (
    (completado and completado_en is not null) or
    (not completado and completado_en is null)
  )
);

create or replace function public.validar_secuencia_capacitacion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  curso_orden smallint;
  curso_bloqueante text;
begin
  select orden into curso_orden
  from public.capacitaciones
  where id_curso = new.curso_id;

  if curso_orden is null then
    raise exception 'La capacitacion seleccionada no existe.';
  end if;

  if new.completado then
    select c.id_curso into curso_bloqueante
    from public.capacitaciones c
    left join public.usuario_capacitaciones uc
      on uc.curso_id = c.id_curso
     and uc.usuario_id = new.usuario_id
     and uc.completado = true
    where c.activo = true
      and c.orden < curso_orden
      and uc.id is null
    order by c.orden
    limit 1;

    if curso_bloqueante is not null then
      raise exception 'Debes completar % antes de marcar %.', curso_bloqueante, new.curso_id;
    end if;

    new.completado_en = coalesce(new.completado_en, now());
  else
    select c.id_curso into curso_bloqueante
    from public.capacitaciones c
    join public.usuario_capacitaciones uc
      on uc.curso_id = c.id_curso
     and uc.usuario_id = new.usuario_id
     and uc.completado = true
    where c.activo = true
      and c.orden > curso_orden
    order by c.orden desc
    limit 1;

    if curso_bloqueante is not null then
      raise exception 'No puedes desmarcar % mientras % siga completada.', new.curso_id, curso_bloqueante;
    end if;

    new.completado_en = null;
    new.completado_por = null;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_validar_secuencia_capacitacion on public.usuario_capacitaciones;
create trigger trg_validar_secuencia_capacitacion
before insert or update of completado on public.usuario_capacitaciones
for each row execute function public.validar_secuencia_capacitacion();

create index if not exists idx_usuario_capacitaciones_usuario
  on public.usuario_capacitaciones(usuario_id);

create index if not exists idx_usuario_capacitaciones_curso
  on public.usuario_capacitaciones(curso_id);

grant select on public.capacitaciones to anon, authenticated, service_role;
grant select, insert, update, delete on public.usuario_capacitaciones to service_role;
grant usage, select on sequence public.usuario_capacitaciones_id_seq to service_role;

notify pgrst, 'reload schema';

commit;
