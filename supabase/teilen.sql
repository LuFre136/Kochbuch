-- Erweiterung fürs Teilen. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach schema.sql). Kann gefahrlos mehrfach ausgeführt werden.

-- 1) Einzelne Rezepte per Link teilen ------------------------------------------

alter table public.recipes add column if not exists share_token uuid unique;

-- Liefert ein Rezept zu einem Teilen-Link, auch ohne Anmeldung.
create or replace function public.get_shared_recipe(p_token uuid)
returns setof public.recipes
language sql stable security definer set search_path = ''
as $$
  select * from public.recipes where p_token is not null and share_token = p_token;
$$;

revoke all on function public.get_shared_recipe(uuid) from public;
grant execute on function public.get_shared_recipe(uuid) to anon, authenticated;

-- 2) Lesezugriff auf das ganze Kochbuch ------------------------------------------

create table if not exists public.cookbook_readers (
  owner_id   uuid not null references auth.users (id) on delete cascade,
  reader_id  uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, reader_id),
  check (owner_id <> reader_id)
);

alter table public.cookbook_readers enable row level security;

drop policy if exists "Freigaben sehen" on public.cookbook_readers;
create policy "Freigaben sehen" on public.cookbook_readers
  for select to authenticated
  using (owner_id = (select auth.uid()) or reader_id = (select auth.uid()));

-- Besitzer können Leser entfernen, Leser können ein Kochbuch verlassen.
drop policy if exists "Freigaben beenden" on public.cookbook_readers;
create policy "Freigaben beenden" on public.cookbook_readers
  for delete to authenticated
  using (owner_id = (select auth.uid()) or reader_id = (select auth.uid()));

-- Ein Einladungslink pro Kochbuch. Neu erzeugen macht den alten Link ungültig.
create table if not exists public.cookbook_invites (
  owner_id   uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token      uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.cookbook_invites enable row level security;

drop policy if exists "Eigene Einladung verwalten" on public.cookbook_invites;
create policy "Eigene Einladung verwalten" on public.cookbook_invites
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Leser dürfen die Rezepte der Kochbücher sehen, für die sie freigeschaltet sind.
drop policy if exists "Geteilte Kochbücher lesen" on public.recipes;
create policy "Geteilte Kochbücher lesen" on public.recipes
  for select to authenticated
  using (exists (
    select 1 from public.cookbook_readers c
    where c.owner_id = recipes.owner_id and c.reader_id = (select auth.uid())
  ));

-- Einladung annehmen: trägt den angemeldeten Nutzer als Leser ein.
create or replace function public.accept_cookbook_invite(p_token uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden.';
  end if;
  select owner_id into v_owner from public.cookbook_invites where token = p_token;
  if v_owner is null then
    raise exception 'Diese Einladung ist ungültig oder wurde zurückgezogen.';
  end if;
  if v_owner <> auth.uid() then
    insert into public.cookbook_readers (owner_id, reader_id)
    values (v_owner, auth.uid())
    on conflict do nothing;
  end if;
  return v_owner;
end $$;

revoke all on function public.accept_cookbook_invite(uuid) from public;
grant execute on function public.accept_cookbook_invite(uuid) to authenticated;

-- Zeigt zu den eigenen Freigaben die E-Mail-Adressen an, damit man weiß, wer wer ist.
-- Liefert nur Zeilen, an denen der Aufrufer selbst beteiligt ist.
create or replace function public.cookbook_people()
returns table (owner_id uuid, reader_id uuid, owner_email text, reader_email text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select c.owner_id, c.reader_id, o.email::text, r.email::text, c.created_at
  from public.cookbook_readers c
  join auth.users o on o.id = c.owner_id
  join auth.users r on r.id = c.reader_id
  where c.owner_id = (select auth.uid()) or c.reader_id = (select auth.uid());
$$;

revoke all on function public.cookbook_people() from public;
grant execute on function public.cookbook_people() to authenticated;
