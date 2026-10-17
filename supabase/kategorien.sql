-- Kategorien für Zutaten (Obst, Gemüse, Fleisch …). Einmal im Supabase-Dashboard unter
-- "SQL Editor" ausführen. Kann gefahrlos mehrfach ausgeführt werden.
-- Jeder Nutzer hat eigene Zuordnungen; key ist der normalisierte Zutatenname aus der App
-- (z. B. "zwiebel" für "Zwiebeln" und "Zwiebel, gehackt").

create table if not exists public.ingredient_categories (
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 200),
  category   text not null check (char_length(category) between 1 and 60),
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);

alter table public.ingredient_categories enable row level security;

drop policy if exists "Eigene Kategorien" on public.ingredient_categories;
create policy "Eigene Kategorien" on public.ingredient_categories
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop trigger if exists ingredient_categories_touch on public.ingredient_categories;
create trigger ingredient_categories_touch before update on public.ingredient_categories
  for each row execute function public.touch_updated_at();
