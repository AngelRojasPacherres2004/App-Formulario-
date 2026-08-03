-- Permite administrar cada capacitacion como pendiente, en curso o finalizada.
-- Mantiene completado para compatibilidad: solo es true cuando estado = finalizado.

begin;

alter table public.usuario_capacitaciones
  add column if not exists estado text;

update public.usuario_capacitaciones
set estado = case when completado then 'finalizado' else 'pendiente' end
where estado is null
   or estado not in ('pendiente', 'en_curso', 'finalizado');

alter table public.usuario_capacitaciones
  alter column estado set default 'pendiente',
  alter column estado set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'capacitacion_estado_valido'
      and conrelid = 'public.usuario_capacitaciones'::regclass
  ) then
    alter table public.usuario_capacitaciones
      add constraint capacitacion_estado_valido
      check (estado in ('pendiente', 'en_curso', 'finalizado'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'capacitacion_estado_completado_coherente'
      and conrelid = 'public.usuario_capacitaciones'::regclass
  ) then
    alter table public.usuario_capacitaciones
      add constraint capacitacion_estado_completado_coherente
      check (completado = (estado = 'finalizado'));
  end if;
end;
$$;

create or replace function public.sincronizar_estado_capacitacion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.estado := replace(lower(trim(coalesce(new.estado, 'pendiente'))), ' ', '_');

  if tg_op = 'INSERT' then
    if new.completado and new.estado = 'pendiente' then
      new.estado := 'finalizado';
    else
      new.completado := new.estado = 'finalizado';
    end if;
  elsif new.estado is distinct from old.estado then
    new.completado := new.estado = 'finalizado';
  elsif new.completado is distinct from old.completado then
    new.estado := case when new.completado then 'finalizado' else 'pendiente' end;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sincronizar_estado_capacitacion on public.usuario_capacitaciones;
create trigger trg_sincronizar_estado_capacitacion
before insert or update of estado, completado on public.usuario_capacitaciones
for each row execute function public.sincronizar_estado_capacitacion();

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
  where id = new.capacitacion_id
    and id_curso = new.curso_id;

  if curso_orden is null then
    raise exception 'La capacitacion seleccionada no existe.';
  end if;

  if new.estado in ('en_curso', 'finalizado') then
    select c.id_curso into curso_bloqueante
    from public.capacitaciones c
    left join public.usuario_capacitaciones uc
      on uc.curso_id = c.id_curso
     and uc.usuario_id = new.usuario_id
     and uc.estado = 'finalizado'
    where c.activo = true
      and c.orden < curso_orden
      and uc.id is null
    order by c.orden
    limit 1;

    if curso_bloqueante is not null then
      raise exception 'Debes finalizar % antes de cambiar el estado de %.', curso_bloqueante, new.curso_id;
    end if;
  end if;

  if new.estado = 'finalizado' then
    new.completado_en = coalesce(new.completado_en, now());
  else
    select c.id_curso into curso_bloqueante
    from public.capacitaciones c
    join public.usuario_capacitaciones uc
      on uc.curso_id = c.id_curso
     and uc.usuario_id = new.usuario_id
     and uc.estado in ('en_curso', 'finalizado')
    where c.activo = true
      and c.orden > curso_orden
    order by c.orden desc
    limit 1;

    if curso_bloqueante is not null then
      raise exception 'No puedes retroceder % mientras % siga en curso o finalizada.', new.curso_id, curso_bloqueante;
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
before insert or update of estado, completado on public.usuario_capacitaciones
for each row execute function public.validar_secuencia_capacitacion();

create index if not exists idx_usuario_capacitaciones_estado
  on public.usuario_capacitaciones(estado);

notify pgrst, 'reload schema';

commit;

select estado, count(*) as registros
from public.usuario_capacitaciones
group by estado
order by estado;
