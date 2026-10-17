-- Einkaufsorte (Supermarkt, Drogeriemarkt, Markt …). Einmal im Supabase-Dashboard unter
-- "SQL Editor" ausführen (nach kategorien.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Jeder Nutzer hat eigene Orte; die App legt beim ersten Öffnen die Standard-Orte an.
-- Welche Orte zu einer Zutat gehören, steht wie die Kategorie in ingredient_categories.

create table if not exists public.shopping_places (
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null check (char_length(id) between 1 and 60),
  name       text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

alter table public.shopping_places enable row level security;

drop policy if exists "Eigene Orte" on public.shopping_places;
create policy "Eigene Orte" on public.shopping_places
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Kennungen der Orte je Zutat, z. B. {supermarkt,markt}. null = noch nicht festgelegt.
alter table public.ingredient_categories add column if not exists places text[];
