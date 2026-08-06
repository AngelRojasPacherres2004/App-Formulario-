-- Normaliza los estados de asistencia a AUSENTE, PUNTUAL o TARDANZA
-- y agrega el conteo de ausentes al historial de reportes.

update public.asistencias
set estado = case
  when upper(btrim(estado)) in ('TARDANZA') then 'TARDANZA'
  when upper(btrim(estado)) in ('PRESENTE', 'PUNTUAL') then 'PUNTUAL'
  else 'AUSENTE'
end
where estado is null or upper(btrim(estado)) not in ('AUSENTE', 'PUNTUAL', 'TARDANZA');

alter table public.asistencias
  alter column estado set default 'AUSENTE';

alter table public.asistencias
  drop constraint if exists asistencias_estado_check;

alter table public.asistencias
  add constraint asistencias_estado_check
  check (estado in ('AUSENTE', 'PUNTUAL', 'TARDANZA'));

alter table public.reporte_asistencia_envios
  add column if not exists ausentes_count integer;

alter table public.reporte_asistencia_envios
  drop constraint if exists reporte_asistencia_ausentes_validos;

alter table public.reporte_asistencia_envios
  add constraint reporte_asistencia_ausentes_validos
  check (ausentes_count is null or ausentes_count >= 0);

notify pgrst, 'reload schema';
