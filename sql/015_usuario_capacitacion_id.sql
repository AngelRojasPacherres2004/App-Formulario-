-- Agrega la clave numerica requerida por Power BI sin perder el progreso existente.
-- Relacion: usuario_capacitaciones.capacitacion_id -> capacitaciones.id.

begin;

alter table public.usuario_capacitaciones
  add column if not exists capacitacion_id bigint;

update public.usuario_capacitaciones uc
set capacitacion_id = c.id
from public.capacitaciones c
where c.id_curso = uc.curso_id
  and uc.capacitacion_id is distinct from c.id;

do $$
begin
  if exists (
    select 1
    from public.usuario_capacitaciones
    where capacitacion_id is null
  ) then
    raise exception 'Hay registros cuyo curso_id no existe en capacitaciones. Corrigelos antes de continuar.';
  end if;
end;
$$;

alter table public.usuario_capacitaciones
  alter column capacitacion_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_usuario_capacitaciones_capacitacion'
      and conrelid = 'public.usuario_capacitaciones'::regclass
  ) then
    alter table public.usuario_capacitaciones
      add constraint fk_usuario_capacitaciones_capacitacion
      foreign key (capacitacion_id)
      references public.capacitaciones(id)
      on delete restrict;
  end if;
end;
$$;

create unique index if not exists uq_usuario_capacitacion_numerica
  on public.usuario_capacitaciones(usuario_id, capacitacion_id);

create index if not exists idx_usuario_capacitaciones_capacitacion
  on public.usuario_capacitaciones(capacitacion_id);

create or replace function public.sincronizar_referencia_capacitacion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.capacitacion_id is null and new.curso_id is null then
    raise exception 'Debes indicar la capacitacion.';
  end if;

  if new.capacitacion_id is null then
    new.capacitacion_id := (
      select id
      from public.capacitaciones
      where id_curso = new.curso_id
    );
  elsif new.curso_id is null then
    new.curso_id := (
      select id_curso
      from public.capacitaciones
      where id = new.capacitacion_id
    );
  elsif not exists (
    select 1
    from public.capacitaciones
    where id = new.capacitacion_id
      and id_curso = new.curso_id
  ) then
    raise exception 'El ID y el codigo de capacitacion no corresponden al mismo curso.';
  end if;

  if new.capacitacion_id is null or new.curso_id is null then
    raise exception 'La capacitacion seleccionada no existe.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sincronizar_referencia_capacitacion on public.usuario_capacitaciones;
create trigger trg_sincronizar_referencia_capacitacion
before insert or update of capacitacion_id, curso_id on public.usuario_capacitaciones
for each row execute function public.sincronizar_referencia_capacitacion();

notify pgrst, 'reload schema';

commit;

select
  count(*) as registros_totales,
  count(uc.capacitacion_id) as registros_con_id,
  count(c.id) as relaciones_validas
from public.usuario_capacitaciones uc
left join public.capacitaciones c
  on c.id = uc.capacitacion_id
 and c.id_curso = uc.curso_id;
