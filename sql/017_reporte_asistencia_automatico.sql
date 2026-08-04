-- Configuracion e historial del reporte diario de asistencia por correo.
-- Las credenciales de Gmail NO se guardan aqui: deben vivir como variables
-- privadas de Netlify Functions (GMAIL_USER y GMAIL_APP_PASSWORD).

begin;

create table if not exists public.configuracion_reporte_asistencia (
  id smallint primary key default 1,
  activo boolean not null default false,
  destinatarios text[] not null default '{}'::text[],
  hora_envio time without time zone not null default '18:00',
  zona_horaria text not null default 'America/Lima',
  asunto text not null default 'Reporte diario de asistencia',
  ultimo_envio_fecha date,
  ultimo_envio_en timestamptz,
  actualizado_por bigint references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint configuracion_reporte_asistencia_unica check (id = 1),
  constraint configuracion_reporte_destinatarios_limite check (cardinality(destinatarios) <= 20),
  constraint configuracion_reporte_activa_con_destino check (not activo or cardinality(destinatarios) > 0),
  constraint configuracion_reporte_asunto_valido check (char_length(trim(asunto)) between 1 and 160)
);

create table if not exists public.reporte_asistencia_envios (
  id bigserial primary key,
  configuracion_id smallint not null default 1
    references public.configuracion_reporte_asistencia(id) on delete restrict,
  fecha_reporte date not null,
  tipo_envio text not null,
  estado text not null default 'procesando',
  destinatarios text[] not null,
  asistentes_count integer,
  intentos smallint not null default 1,
  mensaje_id text,
  detalle_error text,
  iniciado_por bigint references public.usuarios(id) on delete set null,
  enviado_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reporte_asistencia_tipo_valido check (tipo_envio in ('automatico', 'manual')),
  constraint reporte_asistencia_estado_valido check (estado in ('procesando', 'enviando', 'enviado', 'error', 'omitido', 'revision')),
  constraint reporte_asistencia_asistentes_validos check (asistentes_count is null or asistentes_count >= 0),
  constraint reporte_asistencia_intentos_validos check (intentos > 0)
);

create unique index if not exists uq_reporte_asistencia_automatico_fecha
  on public.reporte_asistencia_envios(configuracion_id, fecha_reporte)
  where tipo_envio = 'automatico';

create index if not exists idx_reporte_asistencia_envios_created_at
  on public.reporte_asistencia_envios(created_at desc);

create or replace function public.actualizar_reporte_asistencia_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_configuracion_reporte_asistencia_updated_at
  on public.configuracion_reporte_asistencia;
create trigger trg_configuracion_reporte_asistencia_updated_at
before update on public.configuracion_reporte_asistencia
for each row execute function public.actualizar_reporte_asistencia_updated_at();

drop trigger if exists trg_reporte_asistencia_envios_updated_at
  on public.reporte_asistencia_envios;
create trigger trg_reporte_asistencia_envios_updated_at
before update on public.reporte_asistencia_envios
for each row execute function public.actualizar_reporte_asistencia_updated_at();

-- Reclama atomicamente el envio automatico. Permite hasta tres intentos cuando
-- hubo un error previo y recupera procesos que murieron antes de contactar Gmail.
-- Los estados "enviando" y "revision" no se reintentan para evitar duplicar un
-- correo cuya entrega haya quedado incierta.
create or replace function public.reclamar_reporte_asistencia(
  p_fecha_reporte date,
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
  registro public.reporte_asistencia_envios%rowtype;
begin
  insert into public.reporte_asistencia_envios (
    configuracion_id,
    fecha_reporte,
    tipo_envio,
    estado,
    destinatarios,
    intentos
  )
  values (1, p_fecha_reporte, 'automatico', 'procesando', p_destinatarios, 1)
  on conflict (configuracion_id, fecha_reporte)
    where tipo_envio = 'automatico'
    do nothing
  returning * into registro;

  if found then
    return query select registro.id, true, 'nuevo'::text, registro.intentos;
    return;
  end if;

  select *
  into registro
  from public.reporte_asistencia_envios
  where configuracion_id = 1
    and fecha_reporte = p_fecha_reporte
    and tipo_envio = 'automatico'
  for update;

  if registro.estado = 'enviado' then
    return query select registro.id, false, 'ya_enviado'::text, registro.intentos;
    return;
  end if;

  if registro.estado in ('enviando', 'revision') then
    return query select registro.id, false, 'requiere_revision'::text, registro.intentos;
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

  update public.reporte_asistencia_envios
  set estado = 'procesando',
      destinatarios = p_destinatarios,
      detalle_error = null,
      intentos = registro.intentos + 1
  where id = registro.id
  returning * into registro;

  return query select registro.id, true, 'reintento'::text, registro.intentos;
end;
$$;

insert into public.configuracion_reporte_asistencia (
  id,
  activo,
  destinatarios,
  hora_envio,
  zona_horaria,
  asunto
)
values (
  1,
  false,
  '{}'::text[],
  '18:00',
  'America/Lima',
  'Reporte diario de asistencia'
)
on conflict (id) do nothing;

revoke all on table public.configuracion_reporte_asistencia from anon, authenticated;
revoke all on table public.reporte_asistencia_envios from anon, authenticated;
revoke all on function public.reclamar_reporte_asistencia(date, text[], timestamptz) from public, anon, authenticated;
grant all on table public.configuracion_reporte_asistencia to service_role;
grant all on table public.reporte_asistencia_envios to service_role;
grant usage, select on sequence public.reporte_asistencia_envios_id_seq to service_role;
grant execute on function public.reclamar_reporte_asistencia(date, text[], timestamptz) to service_role;

comment on table public.configuracion_reporte_asistencia is
  'Configuracion unica del reporte diario de asistencia. No contiene credenciales de Gmail.';
comment on table public.reporte_asistencia_envios is
  'Historial auditable de reportes de asistencia enviados o fallidos.';

notify pgrst, 'reload schema';

commit;

select id, activo, destinatarios, hora_envio, zona_horaria, asunto
from public.configuracion_reporte_asistencia;
