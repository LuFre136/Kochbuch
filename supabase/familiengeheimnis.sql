-- Familiengeheimnis. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach teilen.sql und alternativen.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Ein Rezept mit family_secret sehen Leser des Kochbuchs nicht. Die Sperre sitzt in den
-- Zugriffsregeln, gilt also auch für jemanden, der die App umgeht.
-- Einzeln geteilte Rezepte (Teilen-Link) bleiben für ihre Empfänger sichtbar.

alter table public.recipes add column if not exists family_secret boolean not null default false;

-- Leser freigegebener Kochbücher: alles außer Familiengeheimnissen.
drop policy if exists "Geteilte Kochbücher lesen" on public.recipes;
create policy "Geteilte Kochbücher lesen" on public.recipes
  for select to authenticated
  using (
    not family_secret
    and exists (
      select 1 from public.cookbook_readers c
      where c.owner_id = recipes.owner_id and c.reader_id = (select auth.uid())
    )
  );

-- Ist eines der beiden Rezepte ein Familiengeheimnis? security definer, damit die Regel
-- unten auch Rezepte prüfen kann, die der Leser selbst nicht sehen darf.
create or replace function public.involves_family_secret(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.recipes r where r.id in (p_a, p_b) and r.family_secret);
$$;

revoke all on function public.involves_family_secret(uuid, uuid) from public;
grant execute on function public.involves_family_secret(uuid, uuid) to authenticated;

-- Verknüpfungen mit einem Familiengeheimnis bekommen Leser nicht, damit nicht einmal
-- durchsickert, dass es zu einem Rezept ein geheimes Gegenstück gibt.
drop policy if exists "Geteilte Alternativen lesen" on public.recipe_alternatives;
create policy "Geteilte Alternativen lesen" on public.recipe_alternatives
  for select to authenticated
  using (
    exists (
      select 1 from public.cookbook_readers c
      where c.owner_id = recipe_alternatives.owner_id and c.reader_id = (select auth.uid())
    )
    and not public.involves_family_secret(recipe_a, recipe_b)
  );
