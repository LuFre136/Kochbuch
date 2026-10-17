-- Alternativrezepte. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach schema.sql und teilen.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Eine Verknüpfung ist ein Datensatz je Rezeptpaar und gilt deshalb in beide
-- Richtungen. Das Paar wird immer sortiert gespeichert (recipe_a < recipe_b),
-- so kann es A–B und B–A nicht doppelt geben.

create table if not exists public.recipe_alternatives (
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipe_a   uuid not null references public.recipes (id) on delete cascade,
  recipe_b   uuid not null references public.recipes (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recipe_a, recipe_b),
  constraint recipe_alternatives_sorted check (recipe_a < recipe_b)
);

create index if not exists recipe_alternatives_b_idx on public.recipe_alternatives (recipe_b);
create index if not exists recipe_alternatives_owner_idx on public.recipe_alternatives (owner_id);

alter table public.recipe_alternatives enable row level security;

-- Verknüpfen und lösen darf man nur zwischen eigenen Rezepten.
drop policy if exists "Eigene Alternativen verwalten" on public.recipe_alternatives;
create policy "Eigene Alternativen verwalten" on public.recipe_alternatives
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.recipes r where r.id = recipe_a and r.owner_id = (select auth.uid()))
    and exists (select 1 from public.recipes r where r.id = recipe_b and r.owner_id = (select auth.uid()))
  );

-- Leser eines freigegebenen Kochbuchs sehen dessen Verknüpfungen, damit sie in der
-- Rezeptansicht auch zu den Alternativen wischen können.
drop policy if exists "Geteilte Alternativen lesen" on public.recipe_alternatives;
create policy "Geteilte Alternativen lesen" on public.recipe_alternatives
  for select to authenticated
  using (exists (
    select 1 from public.cookbook_readers c
    where c.owner_id = recipe_alternatives.owner_id and c.reader_id = (select auth.uid())
  ));
