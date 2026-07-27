-- Guarda el sueldo directamente en la tabla de usuarios.

alter table public.usuarios
  add column if not exists sueldo numeric(12,2);

update public.usuarios
set sueldo = 0
where sueldo is null;

alter table public.usuarios
  alter column sueldo set default 0,
  alter column sueldo set not null;

alter table public.usuarios
  drop constraint if exists usuarios_sueldo_check;

alter table public.usuarios
  add constraint usuarios_sueldo_check
  check (sueldo >= 0);
