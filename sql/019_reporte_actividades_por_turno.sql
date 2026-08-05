begin;

create table if not exists public.configuracion_reporte_actividad (
  id smallint primary key default 1 check (id = 1),
  activo boolean not null default false,
  destinatarios text[] not null default '{}',
  hora_manana time without time zone not null default '12:00',
  hora_tarde time without time zone not null default '18:00',
  zona_horaria text not null default 'America/Lima',
  asunto text not null default 'Reporte de registros de actividades',
  ultimo_envio_manana_fecha date,
  ultimo_envio_tarde_fecha date,
  actualizado_por bigint references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reporte_actividad_horas_validas check (hora_manana < hora_tarde),
  constraint reporte_actividad_asunto_valido check (char_length(trim(asunto)) between 1 and 160),
  constraint reporte_actividad_destinatarios_limite check (cardinality(destinatarios) <= 20),
  constraint reporte_actividad_activo_destinatarios check (not activo or cardinality(destinatarios) > 0)
);

create table if not exists public.reporte_actividad_envios (
  id bigserial primary key,
  configuracion_id smallint not null default 1 references public.configuracion_reporte_actividad(id) on delete restrict,
  fecha_reporte date not null,
  turno text not null check (turno in ('manana', 'tarde')),
  tipo_envio text not null check (tipo_envio in ('automatico', 'manual')),
  estado text not null check (estado in ('procesando', 'enviado', 'error')),
  destinatarios text[] not null,
  cumplieron_count integer check (cumplieron_count is null or cumplieron_count >= 0),
  sin_registro_count integer check (sin_registro_count is null or sin_registro_count >= 0),
  mensaje_id text,
  detalle_error text,
  intentos smallint not null default 1 check (intentos between 1 and 3),
  iniciado_por bigint references public.usuarios(id) on delete set null,
  enviado_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reporte_actividad_envios
  add column if not exists intentos smallint not null default 1;

create unique index if not exists uq_reporte_actividad_automatico_turno
  on public.reporte_actividad_envios(configuracion_id, fecha_reporte, turno)
  where tipo_envio = 'automatico';
create index if not exists idx_reporte_actividad_envios_created_at
  on public.reporte_actividad_envios(created_at desc);

create or replace function public.actualizar_reporte_actividad_updated_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_configuracion_reporte_actividad_updated_at on public.configuracion_reporte_actividad;
create trigger trg_configuracion_reporte_actividad_updated_at before update on public.configuracion_reporte_actividad
for each row execute function public.actualizar_reporte_actividad_updated_at();
drop trigger if exists trg_reporte_actividad_envios_updated_at on public.reporte_actividad_envios;
create trigger trg_reporte_actividad_envios_updated_at before update on public.reporte_actividad_envios
for each row execute function public.actualizar_reporte_actividad_updated_at();

insert into public.configuracion_reporte_actividad (id) values (1) on conflict (id) do nothing;

create or replace function public.reclamar_reporte_actividad(
  p_fecha_reporte date,
  p_turno text,
  p_destinatarios text[],
  p_ahora timestamptz default now()
)
returns table (envio_id bigint, reclamado boolean, motivo text, intento smallint)
language plpgsql security definer set search_path = public as $$
declare
  registro public.reporte_actividad_envios%rowtype;
begin
  if p_turno not in ('manana', 'tarde') then
    raise exception using errcode = '22023', message = 'El turno no es valido.';
  end if;
  if not exists (select 1 from public.configuracion_reporte_actividad where id = 1 and activo) then
    return query select null::bigint, false, 'programacion_inactiva'::text, 0::smallint;
    return;
  end if;
  insert into public.reporte_actividad_envios
    (configuracion_id, fecha_reporte, turno, tipo_envio, estado, destinatarios, intentos)
  values (1, p_fecha_reporte, p_turno, 'automatico', 'procesando', p_destinatarios, 1)
  on conflict (configuracion_id, fecha_reporte, turno) where tipo_envio = 'automatico' do nothing
  returning * into registro;
  if found then
    return query select registro.id, true, 'nuevo'::text, registro.intentos;
    return;
  end if;
  select * into registro from public.reporte_actividad_envios
  where configuracion_id = 1 and fecha_reporte = p_fecha_reporte and turno = p_turno and tipo_envio = 'automatico'
  for update;
  if registro.estado = 'enviado' then
    return query select registro.id, false, 'ya_enviado'::text, registro.intentos;
    return;
  end if;
  if registro.estado = 'procesando' and registro.updated_at >= p_ahora - interval '2 minutes' then
    return query select registro.id, false, 'en_proceso'::text, registro.intentos;
    return;
  end if;
  if registro.intentos >= 3 then
    return query select registro.id, false, 'maximo_intentos'::text, registro.intentos;
    return;
  end if;
  update public.reporte_actividad_envios
  set estado = 'procesando', destinatarios = p_destinatarios, detalle_error = null, intentos = registro.intentos + 1
  where id = registro.id returning * into registro;
  return query select registro.id, true, 'reintento'::text, registro.intentos;
end;
$$;

revoke all on table public.configuracion_reporte_actividad, public.reporte_actividad_envios from public, anon, authenticated;
grant select, insert, update on table public.configuracion_reporte_actividad, public.reporte_actividad_envios to service_role;
grant usage, select on sequence public.reporte_actividad_envios_id_seq to service_role;
revoke all on function public.actualizar_reporte_actividad_updated_at() from public, anon, authenticated;
revoke all on function public.reclamar_reporte_actividad(date, text, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.reclamar_reporte_actividad(date, text, text[], timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
