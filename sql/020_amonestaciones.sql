-- Amonestaciones registradas por el administrador para cada usuario.

create table if not exists public.amonestaciones (
  id bigserial primary key,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  descripcion text not null,
  created_by bigint references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_amonestaciones_usuario_id on public.amonestaciones(usuario_id);
create index if not exists idx_amonestaciones_created_at on public.amonestaciones(created_at desc);
