-- Benutzernamen. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach teilen.sql und einkauf.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Danach sehen andere beim Teilen von Kochbüchern und Einkaufslisten nur noch den
-- Benutzernamen, nicht mehr die E-Mail-Adresse.

create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  username   text not null check (username = btrim(username) and username ~ '^[A-Za-z0-9ÄÖÜäöüß ._-]{3,30}$'),
  created_at timestamptz not null default now()
);

-- Jeder Name nur einmal, unabhängig von Groß- und Kleinschreibung.
create unique index if not exists profiles_username_key on public.profiles (lower(username));

alter table public.profiles enable row level security;

-- Den eigenen Namen sehen und ändern. Die Namen der anderen liefern nur die Funktionen unten.
drop policy if exists "Eigenes Profil lesen" on public.profiles;
create policy "Eigenes Profil lesen" on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Eigenes Profil anlegen" on public.profiles;
create policy "Eigenes Profil anlegen" on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "Eigenes Profil ändern" on public.profiles;
create policy "Eigenes Profil ändern" on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Freigaben des Kochbuchs mit Benutzernamen statt E-Mail-Adressen.
drop function if exists public.cookbook_people();
create function public.cookbook_people()
returns table (owner_id uuid, reader_id uuid, owner_name text, reader_name text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select c.owner_id, c.reader_id,
         coalesce(o.username, 'Ohne Namen'), coalesce(r.username, 'Ohne Namen'), c.created_at
  from public.cookbook_readers c
  left join public.profiles o on o.user_id = c.owner_id
  left join public.profiles r on r.user_id = c.reader_id
  where c.owner_id = (select auth.uid()) or c.reader_id = (select auth.uid());
$$;

revoke all on function public.cookbook_people() from public;
grant execute on function public.cookbook_people() to authenticated;

-- Beteiligte einer Einkaufsliste mit Benutzernamen.
drop function if exists public.list_people(uuid);
create function public.list_people(p_list uuid)
returns table (user_id uuid, name text, is_owner boolean)
language sql stable security definer set search_path = ''
as $$
  select l.owner_id, coalesce(p.username, 'Ohne Namen'), true
  from public.shopping_lists l left join public.profiles p on p.user_id = l.owner_id
  where l.id = p_list and public.can_use_list(p_list)
  union all
  select m.user_id, coalesce(p.username, 'Ohne Namen'), false
  from public.shopping_list_members m left join public.profiles p on p.user_id = m.user_id
  where m.list_id = p_list and public.can_use_list(p_list);
$$;

revoke all on function public.list_people(uuid) from public;
grant execute on function public.list_people(uuid) to authenticated;
