-- Einkaufslisten. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach schema.sql, teilen.sql und planung.sql). Kann gefahrlos mehrfach ausgeführt werden.

create table if not exists public.shopping_lists (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null default 'Einkaufsliste' check (char_length(name) between 1 and 80),
  invite_token uuid unique,
  created_at   timestamptz not null default now()
);

create index if not exists shopping_lists_owner_idx on public.shopping_lists (owner_id);

-- Wer eine Liste mitbearbeiten darf (außer dem Besitzer).
create table if not exists public.shopping_list_members (
  list_id    uuid not null references public.shopping_lists (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (list_id, user_id)
);

create index if not exists shopping_list_members_user_idx on public.shopping_list_members (user_id);

-- sources: aus welchen Rezepten der Eintrag stammt, z. B.
-- [{"recipe_id": "…", "plan_id": "…", "title": "Bananenbrot", "amount": 3}]
-- amount ist der Anteil des Rezepts in der Einheit des Eintrags.
create table if not exists public.shopping_items (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.shopping_lists (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  amount     numeric,
  unit       text not null default '',
  checked    boolean not null default false,
  manual     boolean not null default false,
  sources    jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shopping_items_list_idx on public.shopping_items (list_id);

drop trigger if exists shopping_items_touch on public.shopping_items;
create trigger shopping_items_touch before update on public.shopping_items
  for each row execute function public.touch_updated_at();

-- Hilfsfunktionen für die Regeln. "security definer", damit sich die Regeln der
-- Tabellen nicht gegenseitig aufrufen.
create or replace function public.can_use_list(p_list uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.shopping_lists l where l.id = p_list and l.owner_id = (select auth.uid()))
      or exists (select 1 from public.shopping_list_members m where m.list_id = p_list and m.user_id = (select auth.uid()));
$$;

create or replace function public.owns_list(p_list uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.shopping_lists l where l.id = p_list and l.owner_id = (select auth.uid()));
$$;

revoke all on function public.can_use_list(uuid) from public;
revoke all on function public.owns_list(uuid) from public;
grant execute on function public.can_use_list(uuid) to authenticated;
grant execute on function public.owns_list(uuid) to authenticated;

alter table public.shopping_lists enable row level security;
alter table public.shopping_list_members enable row level security;
alter table public.shopping_items enable row level security;

-- Listen: sehen dürfen Besitzer und Mitglieder, ändern und löschen nur der Besitzer.
drop policy if exists "Listen sehen" on public.shopping_lists;
create policy "Listen sehen" on public.shopping_lists
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.can_use_list(id));

drop policy if exists "Listen anlegen" on public.shopping_lists;
create policy "Listen anlegen" on public.shopping_lists
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists "Listen ändern" on public.shopping_lists;
create policy "Listen ändern" on public.shopping_lists
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "Listen löschen" on public.shopping_lists;
create policy "Listen löschen" on public.shopping_lists
  for delete to authenticated using (owner_id = (select auth.uid()));

-- Mitglieder: alle Beteiligten sehen einander. Der Besitzer kann Mitglieder entfernen,
-- Mitglieder können die Liste verlassen. Hinzu kommt man nur über accept_list_invite.
drop policy if exists "Mitglieder sehen" on public.shopping_list_members;
create policy "Mitglieder sehen" on public.shopping_list_members
  for select to authenticated using (public.can_use_list(list_id));

drop policy if exists "Mitglieder entfernen" on public.shopping_list_members;
create policy "Mitglieder entfernen" on public.shopping_list_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.owns_list(list_id));

-- Einträge: Besitzer und Mitglieder dürfen alles.
drop policy if exists "Einträge bearbeiten" on public.shopping_items;
create policy "Einträge bearbeiten" on public.shopping_items
  for all to authenticated
  using (public.can_use_list(list_id)) with check (public.can_use_list(list_id));

-- Einladung annehmen: trägt den angemeldeten Nutzer als Mitglied ein.
create or replace function public.accept_list_invite(p_token uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_list uuid;
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden.';
  end if;
  select id, owner_id into v_list, v_owner from public.shopping_lists
  where p_token is not null and invite_token = p_token;
  if v_list is null then
    raise exception 'Diese Einladung ist ungültig oder wurde zurückgezogen.';
  end if;
  if v_owner <> auth.uid() then
    insert into public.shopping_list_members (list_id, user_id)
    values (v_list, auth.uid())
    on conflict do nothing;
  end if;
  return v_list;
end $$;

revoke all on function public.accept_list_invite(uuid) from public;
grant execute on function public.accept_list_invite(uuid) to authenticated;

-- Wer an einer Liste beteiligt ist, mit E-Mail-Adressen. Nur für Beteiligte.
create or replace function public.list_people(p_list uuid)
returns table (user_id uuid, email text, is_owner boolean)
language sql stable security definer set search_path = ''
as $$
  select u.id, u.email::text, true
  from public.shopping_lists l join auth.users u on u.id = l.owner_id
  where l.id = p_list and public.can_use_list(p_list)
  union all
  select u.id, u.email::text, false
  from public.shopping_list_members m join auth.users u on u.id = m.user_id
  where m.list_id = p_list and public.can_use_list(p_list);
$$;

revoke all on function public.list_people(uuid) from public;
grant execute on function public.list_people(uuid) to authenticated;

-- Live-Aktualisierung, damit gemeinsame Listen auf allen Geräten gleich aussehen.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shopping_items') then
    alter publication supabase_realtime add table public.shopping_items;
  end if;
end $$;
