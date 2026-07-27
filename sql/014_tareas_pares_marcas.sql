-- Todas las tareas medidas en pares deben habilitar la distribución por marcas.

update public.tarea
set requiere_marca = true
where lower(btrim(coalesce(unidad_medida, ''))) in ('par', 'pares')
  and requiere_marca is distinct from true;

notify pgrst, 'reload schema';
