-- Analisis de competencia ML - tablas nuevas (aditivo, no toca nada existente)
-- Requiere pgcrypto para gen_random_uuid() (habilitado por defecto en Supabase)
create extension if not exists pgcrypto;

create table if not exists competidores (
  id          uuid primary key default gen_random_uuid(),
  nickname    text not null unique,
  seller_id   text,
  fecha_alta  timestamptz not null default now()
);

create table if not exists competidor_items (
  id             uuid primary key default gen_random_uuid(),
  competidor_id  uuid not null references competidores(id) on delete cascade,
  item_id        text not null,
  titulo         text,
  precio         numeric,
  sold_quantity  integer default 0,
  envio_tipo     text, -- 'FULL' | 'FLEX' | 'COLECTA' | 'DESCONOCIDO'
  fecha_snapshot date not null default current_date,
  created_at     timestamptz not null default now(),
  unique (competidor_id, item_id, fecha_snapshot)
);

create index if not exists idx_competidor_items_competidor_fecha
  on competidor_items (competidor_id, fecha_snapshot);
create index if not exists idx_competidor_items_item_fecha
  on competidor_items (item_id, fecha_snapshot);

create table if not exists matches_manuales (
  id                  uuid primary key default gen_random_uuid(),
  producto_sku        text not null,
  competidor_id       uuid not null references competidores(id) on delete cascade,
  competidor_item_id  text not null, -- item_id de ML (estable entre snapshots)
  confirmado          boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (producto_sku, competidor_id)
);

create index if not exists idx_matches_manuales_competidor_item
  on matches_manuales (competidor_id, competidor_item_id);

-- Defensa en profundidad: solo se accede con la service_role key (ignora RLS),
-- pero se deja RLS activo y sin policies para que ninguna otra key pueda leer/escribir.
alter table competidores     enable row level security;
alter table competidor_items enable row level security;
alter table matches_manuales enable row level security;
