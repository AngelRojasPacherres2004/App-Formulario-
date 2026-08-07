-- Amplia el reporte de registros de actividades para admitir varias
-- programaciones (como ya ocurre con el reporte de asistencia), cada una con
-- su propio nombre, horarios de manana/tarde, destinatarios y alcance de
-- operantes. Requiere haber aplicado previamente sql/019_reporte_actividades_por_turno.sql.

begin;

-- La fila historica con id = 1 se conserva, pero deja de ser la unica posible.
alter table public.configuracion_reporte_actividad
  drop constraint if exists configuracion_reporte_actividad_id_check;

alter table public.configuracion_reporte_actividad
  add column if not exists nombre text,
  add column if not exists incluir_todos_activos boolean not null default true,
  add column if not exists eliminado_en timestamptz,
  add column if not exists eliminado_por bigint;

update public.configuracion_reporte_actividad
set nombre = coalesce(nullif(trim(asunto), ''), 'Reporte de registros de actividades')
where nombre is null or trim(nombre) = '';

alter table public.configuracion_reporte_actividad
  alter column nombre set default 'Nueva programacion de actividades',
  alter column nombre set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'configuracion_reporte_actividad_nombre_valido'
      and conrelid = 'public.configuracion_reporte_actividad'::regclass
  ) then
    alter table public.configuracion_reporte_actividad
      add constraint configuracion_reporte_actividad_nombre_valido
      check (char_length(trim(nombre)) between 1 and 120);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'configuracion_reporte_actividad_borrado_logico_valido'
      and conrelid = 'public.configuracion_reporte_actividad'::regclass
  ) then
    alter table public.configuracion_reporte_actividad
      add constraint configuracion_reporte_actividad_borrado_logico_valido
      check (eliminado_en is null or not activo);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'configuracion_reporte_actividad_eliminado_por_fkey'
      and conrelid = 'public.configuracion_reporte_actividad'::regclass
  ) then
    alter table public.configuracion_reporte_actividad
      add constraint configuracion_reporte_actividad_eliminado_por_fkey
      foreign key (eliminado_por) references public.usuarios(id) on delete set null;
  end if;
end;
$$;

-- smallint permite 32 767 programaciones y evita convertir las claves foraneas
-- existentes. La secuencia comienza despues del mayor id, por lo que id = 1
-- permanece intacto y la siguiente programacion recibe id = 2.
create sequence if not exists public.configuracion_reporte_actividad_id_seq
  as smallint
  minvalue 1
  maxvalue 32767;

alter sequence public.configuracion_reporte_actividad_id_seq
  owned by public.configuracion_reporte_actividad.id;

select setval(
  'public.configuracion_reporte_actividad_id_seq'::regclass,
  coalesce(max(id), 1),
  count(*) > 0
)
from public.configuracion_reporte_actividad;

alter table public.configuracion_reporte_actividad
  alter column id set default nextval('public.configuracion_reporte_actividad_id_seq'::regclass);

-- Cada envio debe declarar siempre a que programacion pertenece. El nombre se
-- conserva como instantanea para que el historial siga siendo legible si la
-- programacion cambia de nombre posteriormente.
alter table public.reporte_actividad_envios
  alter column configuracion_id drop default,
  add column if not exists programacion_nombre text;

update public.reporte_actividad_envios as envio
set programacion_nombre = coalesce(
  nullif(trim(configuracion.nombre), ''),
  'Programacion ' || envio.configuracion_id::text
)
from public.configuracion_reporte_actividad as configuracion
where configuracion.id = envio.configuracion_id
  and (envio.programacion_nombre is null or trim(envio.programacion_nombre) = '');

update public.reporte_actividad_envios
set programacion_nombre = 'Programacion ' || configuracion_id::text
where programacion_nombre is null or trim(programacion_nombre) = '';

create or replace function public.completar_nombre_programacion_reporte_actividad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.programacion_nombre is null or trim(new.programacion_nombre) = '' then
    select nombre
    into new.programacion_nombre
    from public.configuracion_reporte_actividad
    where id = new.configuracion_id;

    new.programacion_nombre := coalesce(
      nullif(trim(new.programacion_nombre), ''),
      'Programacion ' || new.configuracion_id::text
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reporte_actividad_programacion_nombre
  on public.reporte_actividad_envios;
create trigger trg_reporte_actividad_programacion_nombre
before insert on public.reporte_actividad_envios
for each row execute function public.completar_nombre_programacion_reporte_actividad();

alter table public.reporte_actividad_envios
  alter column programacion_nombre set not null;

create index if not exists idx_reporte_actividad_envios_configuracion_created_at
  on public.reporte_actividad_envios(configuracion_id, created_at desc);

create index if not exists idx_configuracion_reporte_actividad_programables
  on public.configuracion_reporte_actividad(activo, id)
  where eliminado_en is null;

-- Cuando incluir_todos_activos = false, esta tabla contiene la seleccion de
-- operantes que puede aparecer en el reporte. Los usuarios inactivos se
-- conservan relacionados para no perder la configuracion, pero el servicio los
-- excluye al consultar; toda nueva seleccion debe apuntar a un operante activo.
create table if not exists public.configuracion_reporte_actividad_usuarios (
  configuracion_id smallint not null
    references public.configuracion_reporte_actividad(id) on delete cascade,
  usuario_id bigint not null
    references public.usuarios(id) on delete restrict,
  seleccionado_por bigint
    references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (configuracion_id, usuario_id)
);

create index if not exists idx_configuracion_reporte_actividad_usuarios_usuario
  on public.configuracion_reporte_actividad_usuarios(usuario_id, configuracion_id);

create or replace function public.validar_usuario_programacion_reporte_actividad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activo boolean;
  v_rol text;
begin
  select
    coalesce(activo, false),
    regexp_replace(
      replace(replace(lower(trim(coalesce(rol, ''))), '_', ' '), '-', ' '),
      '[[:space:]]+',
      ' ',
      'g'
    )
  into v_activo, v_rol
  from public.usuarios
  where id = new.usuario_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'El usuario seleccionado no existe.';
  end if;

  if not v_activo then
    raise exception using
      errcode = '23514',
      message = 'Solo se pueden seleccionar operantes activos.';
  end if;

  if v_rol <> 'operante' then
    raise exception using
      errcode = '23514',
      message = 'Solo se pueden seleccionar operantes.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validar_usuario_programacion_reporte_actividad
  on public.configuracion_reporte_actividad_usuarios;
create trigger trg_validar_usuario_programacion_reporte_actividad
before insert or update of usuario_id
on public.configuracion_reporte_actividad_usuarios
for each row execute function public.validar_usuario_programacion_reporte_actividad();

-- Guarda una programacion y reemplaza su seleccion de operantes en la misma
-- transaccion. p_configuracion_id = null crea una nueva programacion.
create or replace function public.guardar_programacion_reporte_actividad(
  p_configuracion_id smallint,
  p_nombre text,
  p_activo boolean,
  p_destinatarios text[],
  p_hora_manana time without time zone,
  p_hora_tarde time without time zone,
  p_zona_horaria text,
  p_asunto text,
  p_incluir_todos_activos boolean,
  p_usuario_ids bigint[],
  p_actualizado_por bigint
)
returns public.configuracion_reporte_actividad
language plpgsql
security definer
set search_path = public
as $$
declare
  v_configuracion public.configuracion_reporte_actividad%rowtype;
  v_nombre text := nullif(trim(coalesce(p_nombre, '')), '');
  v_asunto text := nullif(trim(coalesce(p_asunto, '')), '');
  v_zona_horaria text := coalesce(nullif(trim(p_zona_horaria), ''), 'America/Lima');
  v_destinatarios text[];
  v_usuario_ids bigint[];
  v_usuarios_invalidos bigint[];
  v_incluir_todos boolean := coalesce(p_incluir_todos_activos, true);
begin
  v_destinatarios := array(
    select distinct lower(trim(destinatario))
    from unnest(coalesce(p_destinatarios, '{}'::text[])) as item(destinatario)
    where destinatario is not null and trim(destinatario) <> ''
    order by 1
  );

  v_usuario_ids := array(
    select distinct usuario_id
    from unnest(coalesce(p_usuario_ids, '{}'::bigint[])) as item(usuario_id)
    where usuario_id is not null
    order by usuario_id
  );

  if v_nombre is null or char_length(v_nombre) > 120 then
    raise exception using
      errcode = '22023',
      message = 'El nombre de la programacion es obligatorio y admite hasta 120 caracteres.';
  end if;

  if v_asunto is null or char_length(v_asunto) > 160 then
    raise exception using
      errcode = '22023',
      message = 'El asunto es obligatorio y admite hasta 160 caracteres.';
  end if;

  if p_hora_manana is null or p_hora_tarde is null then
    raise exception using
      errcode = '22023',
      message = 'Las horas de manana y tarde son obligatorias.';
  end if;

  if p_hora_manana >= p_hora_tarde then
    raise exception using
      errcode = '22023',
      message = 'La hora de la manana debe ser anterior a la hora de la tarde.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = v_zona_horaria
  ) then
    raise exception using
      errcode = '22023',
      message = 'La zona horaria indicada no es valida.';
  end if;

  if cardinality(v_destinatarios) > 20 then
    raise exception using
      errcode = '22023',
      message = 'Solo se permiten hasta 20 correos destinatarios.';
  end if;

  if exists (
    select 1
    from unnest(v_destinatarios) as item(destinatario)
    where destinatario !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Uno o mas correos destinatarios no son validos.';
  end if;

  if coalesce(p_activo, false) and cardinality(v_destinatarios) = 0 then
    raise exception using
      errcode = '22023',
      message = 'Una programacion activa necesita al menos un destinatario.';
  end if;

  if v_incluir_todos then
    v_usuario_ids := '{}'::bigint[];
  elsif cardinality(v_usuario_ids) = 0 then
    raise exception using
      errcode = '22023',
      message = 'Selecciona al menos un operante activo o incluye a todos los activos.';
  end if;

  if cardinality(v_usuario_ids) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'Una programacion admite hasta 1000 operantes seleccionados.';
  end if;

  select array_agg(candidato.usuario_id order by candidato.usuario_id)
  into v_usuarios_invalidos
  from unnest(v_usuario_ids) as candidato(usuario_id)
  left join public.usuarios as usuario on usuario.id = candidato.usuario_id
  where usuario.id is null
     or not coalesce(usuario.activo, false)
     or regexp_replace(
       replace(replace(lower(trim(coalesce(usuario.rol, ''))), '_', ' '), '-', ' '),
       '[[:space:]]+',
       ' ',
       'g'
     ) <> 'operante';

  if cardinality(v_usuarios_invalidos) > 0 then
    raise exception using
      errcode = '22023',
      message = 'La seleccion contiene usuarios inexistentes, inactivos o que no son operantes.';
  end if;

  if p_configuracion_id is null then
    insert into public.configuracion_reporte_actividad (
      nombre,
      activo,
      destinatarios,
      hora_manana,
      hora_tarde,
      zona_horaria,
      asunto,
      incluir_todos_activos,
      actualizado_por
    )
    values (
      v_nombre,
      coalesce(p_activo, false),
      v_destinatarios,
      p_hora_manana,
      p_hora_tarde,
      v_zona_horaria,
      v_asunto,
      v_incluir_todos,
      p_actualizado_por
    )
    returning * into v_configuracion;
  else
    update public.configuracion_reporte_actividad
    set nombre = v_nombre,
        activo = coalesce(p_activo, false),
        destinatarios = v_destinatarios,
        hora_manana = p_hora_manana,
        hora_tarde = p_hora_tarde,
        zona_horaria = v_zona_horaria,
        asunto = v_asunto,
        incluir_todos_activos = v_incluir_todos,
        actualizado_por = p_actualizado_por
    where id = p_configuracion_id
      and eliminado_en is null
    returning * into v_configuracion;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'La programacion no existe o fue eliminada.';
    end if;
  end if;

  delete from public.configuracion_reporte_actividad_usuarios
  where configuracion_id = v_configuracion.id;

  insert into public.configuracion_reporte_actividad_usuarios (
    configuracion_id,
    usuario_id,
    seleccionado_por
  )
  select v_configuracion.id, usuario_id, p_actualizado_por
  from unnest(v_usuario_ids) as seleccion(usuario_id);

  return v_configuracion;
end;
$$;

-- Reclamo atomico por programacion, fecha y turno. El indice unico parcial
-- creado en 019 sigue evitando duplicados, ahora independientemente para
-- cada id de programacion.
create or replace function public.reclamar_reporte_actividad(
  p_configuracion_id smallint,
  p_fecha_reporte date,
  p_turno text,
  p_destinatarios text[],
  p_ahora timestamptz default now()
)
returns table (
  envio_id bigint,
  reclamado boolean,
  motivo text,
  intento smallint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  registro public.reporte_actividad_envios%rowtype;
begin
  if p_turno not in ('manana', 'tarde') then
    raise exception using errcode = '22023', message = 'El turno no es valido.';
  end if;

  if not exists (
    select 1
    from public.configuracion_reporte_actividad
    where id = p_configuracion_id
      and activo
      and eliminado_en is null
  ) then
    return query
      select null::bigint, false, 'programacion_inactiva'::text, 0::smallint;
    return;
  end if;

  insert into public.reporte_actividad_envios (
    configuracion_id,
    fecha_reporte,
    turno,
    tipo_envio,
    estado,
    destinatarios,
    intentos
  )
  values (
    p_configuracion_id,
    p_fecha_reporte,
    p_turno,
    'automatico',
    'procesando',
    p_destinatarios,
    1
  )
  on conflict (configuracion_id, fecha_reporte, turno)
    where tipo_envio = 'automatico'
    do nothing
  returning * into registro;

  if found then
    return query select registro.id, true, 'nuevo'::text, registro.intentos;
    return;
  end if;

  select *
  into registro
  from public.reporte_actividad_envios
  where configuracion_id = p_configuracion_id
    and fecha_reporte = p_fecha_reporte
    and turno = p_turno
    and tipo_envio = 'automatico'
  for update;

  if registro.estado = 'enviado' then
    return query select registro.id, false, 'ya_enviado'::text, registro.intentos;
    return;
  end if;

  if registro.estado = 'procesando'
     and registro.updated_at >= p_ahora - interval '2 minutes' then
    return query select registro.id, false, 'en_proceso'::text, registro.intentos;
    return;
  end if;

  if registro.intentos >= 3 then
    return query select registro.id, false, 'maximo_intentos'::text, registro.intentos;
    return;
  end if;

  update public.reporte_actividad_envios
  set estado = 'procesando',
      destinatarios = p_destinatarios,
      detalle_error = null,
      intentos = registro.intentos + 1
  where id = registro.id
  returning * into registro;

  return query select registro.id, true, 'reintento'::text, registro.intentos;
end;
$$;

-- Firma anterior conservada para que un scheduler previo pueda seguir
-- enviando la programacion historica id = 1 durante el despliegue.
create or replace function public.reclamar_reporte_actividad(
  p_fecha_reporte date,
  p_turno text,
  p_destinatarios text[],
  p_ahora timestamptz default now()
)
returns table (
  envio_id bigint,
  reclamado boolean,
  motivo text,
  intento smallint
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.reclamar_reporte_actividad(
    1::smallint,
    p_fecha_reporte,
    p_turno,
    p_destinatarios,
    p_ahora
  );
$$;

revoke all on table public.configuracion_reporte_actividad_usuarios
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.configuracion_reporte_actividad_usuarios to service_role;

grant usage, select
  on sequence public.configuracion_reporte_actividad_id_seq to service_role;

-- Las configuraciones y el historial se conservan mediante borrado logico.
-- El service role puede crearlos y actualizarlos, pero no eliminarlos.
revoke delete on table public.configuracion_reporte_actividad from service_role;
revoke delete on table public.reporte_actividad_envios from service_role;
grant select, insert, update
  on table public.configuracion_reporte_actividad to service_role;
grant select, insert, update
  on table public.reporte_actividad_envios to service_role;

revoke all on function public.guardar_programacion_reporte_actividad(
  smallint, text, boolean, text[], time without time zone, time without time zone,
  text, text, boolean, bigint[], bigint
) from public, anon, authenticated;
grant execute on function public.guardar_programacion_reporte_actividad(
  smallint, text, boolean, text[], time without time zone, time without time zone,
  text, text, boolean, bigint[], bigint
) to service_role;

revoke all on function public.reclamar_reporte_actividad(
  smallint, date, text, text[], timestamptz
) from public, anon, authenticated;
grant execute on function public.reclamar_reporte_actividad(
  smallint, date, text, text[], timestamptz
) to service_role;

revoke all on function public.reclamar_reporte_actividad(
  date, text, text[], timestamptz
) from public, anon, authenticated;
grant execute on function public.reclamar_reporte_actividad(
  date, text, text[], timestamptz
) to service_role;

revoke all on function public.completar_nombre_programacion_reporte_actividad()
  from public, anon, authenticated;
revoke all on function public.validar_usuario_programacion_reporte_actividad()
  from public, anon, authenticated;

comment on column public.configuracion_reporte_actividad.nombre is
  'Nombre visible que identifica una programacion y sus envios.';
comment on column public.configuracion_reporte_actividad.incluir_todos_activos is
  'Si es true, incluye dinamicamente a todos los operantes activos.';
comment on column public.configuracion_reporte_actividad.eliminado_en is
  'Fecha de borrado logico. Una programacion eliminada siempre permanece inactiva.';
comment on column public.reporte_actividad_envios.programacion_nombre is
  'Nombre de la programacion conservado como instantanea al crear el envio.';
comment on table public.configuracion_reporte_actividad_usuarios is
  'Seleccion explicita de operantes usada cuando incluir_todos_activos es false.';
comment on function public.guardar_programacion_reporte_actividad(
  smallint, text, boolean, text[], time without time zone, time without time zone,
  text, text, boolean, bigint[], bigint
) is 'Crea o actualiza atomicamente una programacion de actividades y reemplaza su seleccion de operantes.';
comment on function public.reclamar_reporte_actividad(
  smallint, date, text, text[], timestamptz
) is 'Reclama atomicamente un envio automatico de actividades para una programacion, fecha y turno concretos.';

notify pgrst, 'reload schema';

commit;

select
  id,
  nombre,
  activo,
  incluir_todos_activos,
  destinatarios,
  hora_manana,
  hora_tarde,
  eliminado_en
from public.configuracion_reporte_actividad
order by id;
