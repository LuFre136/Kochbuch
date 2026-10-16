-- Bewertungen und Essensplanung. Einmal im Supabase-Dashboard unter "SQL Editor"
-- ausführen (nach schema.sql und teilen.sql). Kann gefahrlos mehrfach ausgeführt werden.

-- Bewertung 1–5 Sterne. Ändern darf nur der Besitzer (bestehende Update-Regel).
alter table public.recipes add column if not exists rating smallint check (rating between 1 and 5);

create table if not exists public.meal_plan (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipe_id   uuid not null references public.recipes (id) on delete cascade,
  planned_for date not null,
  servings    integer not null check (servings between 1 and 100),
  created_at  timestamptz not null default now()
);

create index if not exists meal_plan_owner_date_idx on public.meal_plan (owner_id, planned_for);
create index if not exists meal_plan_recipe_idx on public.meal_plan (recipe_id);

alter table public.meal_plan enable row level security;

-- Nur eigene Einträge, und nur für eigene Rezepte.
drop policy if exists "Eigener Plan" on public.meal_plan;
create policy "Eigener Plan" on public.meal_plan
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.recipes r where r.id = recipe_id and r.owner_id = (select auth.uid()))
  );
