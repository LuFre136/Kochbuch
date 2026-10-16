-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Legt die Rezept-Tabelle, die Zugriffsregeln und den Speicher für Bilder an.

create table if not exists public.recipes (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 200),
  description   text not null default '',
  tags          text[] not null default '{}',
  servings      integer not null default 2 check (servings between 1 and 100),
  total_minutes integer check (total_minutes >= 0),
  cook_minutes  integer check (cook_minutes >= 0),
  ingredients   jsonb not null default '[]',  -- [{ amount, amountMax, unit, name }]
  steps         jsonb not null default '[]',  -- ["Schritt 1", "Schritt 2", ...]
  sources       jsonb not null default '[]',  -- ["https://...", ...]
  notes         text not null default '',
  images        text[] not null default '{}', -- Pfade im Bucket recipe-images
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists recipes_owner_idx on public.recipes (owner_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists recipes_touch on public.recipes;
create trigger recipes_touch before update on public.recipes
  for each row execute function public.touch_updated_at();

alter table public.recipes enable row level security;

drop policy if exists "Eigene Rezepte lesen" on public.recipes;
create policy "Eigene Rezepte lesen" on public.recipes
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "Eigene Rezepte anlegen" on public.recipes;
create policy "Eigene Rezepte anlegen" on public.recipes
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists "Eigene Rezepte ändern" on public.recipes;
create policy "Eigene Rezepte ändern" on public.recipes
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "Eigene Rezepte löschen" on public.recipes;
create policy "Eigene Rezepte löschen" on public.recipes
  for delete to authenticated using (owner_id = (select auth.uid()));

-- Bilder: öffentlich lesbar über ihre (nicht erratbare) Adresse, damit geteilte
-- Rezepte später ihre Bilder zeigen können. Schreiben nur in den eigenen Ordner.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-images', 'recipe-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Eigene Bilder sehen" on storage.objects;
create policy "Eigene Bilder sehen" on storage.objects
  for select to authenticated
  using (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Bilder in eigenen Ordner hochladen" on storage.objects;
create policy "Bilder in eigenen Ordner hochladen" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Eigene Bilder ändern" on storage.objects;
create policy "Eigene Bilder ändern" on storage.objects
  for update to authenticated
  using (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Eigene Bilder löschen" on storage.objects;
create policy "Eigene Bilder löschen" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
