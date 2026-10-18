-- Einladungen, die nur einmal gelten. Einmal im Supabase-Dashboard unter "SQL Editor"
-- ausführen (nach teilen.sql, einkauf.sql, benutzername.sql und familiengeheimnis.sql).
-- Kann gefahrlos mehrfach ausgeführt werden.
--
-- Jeder Einladungslink gilt für genau eine Person: Sobald jemand annimmt oder ablehnt,
-- ist er verbraucht. Das gilt für einzelne Rezepte, das Kochbuch und Einkaufslisten.
-- Bisherige Links (Teilen-Link eines Rezepts, Kochbuch- und Listen-Einladung) werden zu
-- offenen Einladungen umgewandelt und funktionieren also noch genau einmal.

-- 1) Tabellen -------------------------------------------------------------------

create table if not exists public.invites (
  id           uuid primary key default gen_random_uuid(),
  -- Code im Link. Leer bei Einladungen, die direkt an eine Person gehen (Zurückteilen).
  token        uuid unique default gen_random_uuid(),
  kind         text not null check (kind in ('recipe', 'cookbook', 'list')),
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipe_id    uuid references public.recipes (id) on delete cascade,
  list_id      uuid references public.shopping_lists (id) on delete cascade,
  invitee_id   uuid references auth.users (id) on delete cascade,
  status       text not null default 'offen' check (status in ('offen', 'angenommen', 'abgelehnt', 'zurueckgezogen')),
  responded_by uuid references auth.users (id) on delete set null,
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint invites_recipe_target check ((kind = 'recipe') = (recipe_id is not null)),
  constraint invites_list_target check ((kind = 'list') = (list_id is not null)),
  constraint invites_reachable check (token is not null or invitee_id is not null)
);

create index if not exists invites_owner_idx on public.invites (owner_id);
create index if not exists invites_invitee_idx on public.invites (invitee_id) where invitee_id is not null;

-- Wer ein einzelnes Rezept lesen darf.
create table if not exists public.recipe_shares (
  recipe_id  uuid not null references public.recipes (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recipe_id, user_id),
  check (owner_id <> user_id)
);

create index if not exists recipe_shares_user_idx on public.recipe_shares (user_id);
create index if not exists recipe_shares_owner_idx on public.recipe_shares (owner_id);

-- 2) Regeln ---------------------------------------------------------------------

alter table public.invites enable row level security;
alter table public.recipe_shares enable row level security;

-- Einladungen sehen nur Absender und (bei direkten Einladungen) der Eingeladene.
drop policy if exists "Einladungen sehen" on public.invites;
create policy "Einladungen sehen" on public.invites
  for select to authenticated
  using (owner_id = (select auth.uid()) or invitee_id = (select auth.uid()));

-- Anlegen nur offen, mit Link und für eigene Rezepte und Listen. Direkte Einladungen
-- an eine Person entstehen nur über eine Funktion (Zurückteilen).
drop policy if exists "Einladungen anlegen" on public.invites;
create policy "Einladungen anlegen" on public.invites
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and status = 'offen' and responded_by is null and responded_at is null
    and invitee_id is null and token is not null
    and (recipe_id is null or exists (select 1 from public.recipes r where r.id = recipe_id and r.owner_id = (select auth.uid())))
    and (list_id is null or exists (select 1 from public.shopping_lists l where l.id = list_id and l.owner_id = (select auth.uid())))
  );
-- Ändern geht nur über respond_invite und withdraw_invite, deshalb keine Update-Regel.

-- Freigaben einzelner Rezepte: sehen und beenden dürfen Besitzer und Empfänger.
-- Angelegt werden sie nur beim Annehmen einer Einladung.
drop policy if exists "Rezeptfreigaben sehen" on public.recipe_shares;
create policy "Rezeptfreigaben sehen" on public.recipe_shares
  for select to authenticated
  using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));

drop policy if exists "Rezeptfreigaben beenden" on public.recipe_shares;
create policy "Rezeptfreigaben beenden" on public.recipe_shares
  for delete to authenticated
  using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));

-- Ein einzeln geteiltes Rezept darf der Empfänger lesen, auch wenn es ein Familiengeheimnis ist.
drop policy if exists "Einzeln geteilte Rezepte lesen" on public.recipes;
create policy "Einzeln geteilte Rezepte lesen" on public.recipes
  for select to authenticated
  using (exists (
    select 1 from public.recipe_shares s
    where s.recipe_id = recipes.id and s.user_id = (select auth.uid())
  ));

-- 3) Bisherige Links übernehmen ----------------------------------------------------

do $$
begin
  if to_regclass('public.cookbook_invites') is not null then
    insert into public.invites (token, kind, owner_id, created_at)
    select token, 'cookbook', owner_id, created_at from public.cookbook_invites
    on conflict (token) do nothing;
    drop table public.cookbook_invites;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'shopping_lists' and column_name = 'invite_token') then
    insert into public.invites (token, kind, owner_id, list_id)
    select invite_token, 'list', owner_id, id from public.shopping_lists where invite_token is not null
    on conflict (token) do nothing;
    alter table public.shopping_lists drop column invite_token;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'recipes' and column_name = 'share_token') then
    insert into public.invites (token, kind, owner_id, recipe_id)
    select share_token, 'recipe', owner_id, id from public.recipes where share_token is not null
    on conflict (token) do nothing;
    drop function if exists public.get_shared_recipe(uuid);
    alter table public.recipes drop column share_token;
  end if;
end $$;

drop function if exists public.accept_cookbook_invite(uuid);
drop function if exists public.accept_list_invite(uuid);

-- 4) Funktionen -------------------------------------------------------------------

-- Hat die angemeldete Person schon, wozu die Einladung einlädt?
create or replace function public.invite_already_granted(p_invite public.invites)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_invite.kind
    when 'cookbook' then exists (select 1 from public.cookbook_readers c
                                 where c.owner_id = p_invite.owner_id and c.reader_id = (select auth.uid()))
    when 'list' then exists (select 1 from public.shopping_list_members m
                             where m.list_id = p_invite.list_id and m.user_id = (select auth.uid()))
    when 'recipe' then exists (select 1 from public.recipe_shares s
                               where s.recipe_id = p_invite.recipe_id and s.user_id = (select auth.uid()))
  end;
$$;

revoke all on function public.invite_already_granted(public.invites) from public;

-- Was auf der Einladungsseite steht: wer wozu einlädt. Auch ohne Anmeldung. Das Rezept
-- selbst gibt es erst nach dem Annehmen, hier nur Titel und Titelbild.
create or replace function public.invite_info(p_token uuid)
returns table (kind text, status text, owner_name text, title text, image text,
               target_id uuid, own boolean, already boolean)
language sql stable security definer set search_path = ''
as $$
  select i.kind, i.status, coalesce(p.username, 'Jemand'),
         coalesce(r.title, l.name),
         r.images[1],
         coalesce(i.recipe_id, i.list_id, i.owner_id),
         coalesce(i.owner_id = (select auth.uid()), false),
         (select auth.uid()) is not null and public.invite_already_granted(i)
  from public.invites i
  left join public.profiles p on p.user_id = i.owner_id
  left join public.recipes r on r.id = i.recipe_id
  left join public.shopping_lists l on l.id = i.list_id
  where p_token is not null and i.token = p_token;
$$;

revoke all on function public.invite_info(uuid) from public;
grant execute on function public.invite_info(uuid) to anon, authenticated;

-- Beantwortet eine Einladung. Gilt nur, solange sie offen ist; die Zeile wird dabei
-- gesperrt, damit von zwei gleichzeitigen Antworten genau eine zählt. Ablehnen geht
-- auch ohne Anmeldung. Die eigene Einladung und eine, deren Zugriff man schon hat,
-- werden nicht verbraucht.
create or replace function public.respond_invite(p_token uuid, p_accept boolean)
returns table (kind text, target_id uuid, owner_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v public.invites;
  v_me uuid := auth.uid();
begin
  select * into v from public.invites i where p_token is not null and i.token = p_token for update;
  if not found then
    raise exception 'Diese Einladung gibt es nicht.';
  end if;
  if v.status = 'zurueckgezogen' then
    raise exception 'Diese Einladung wurde zurückgezogen.';
  end if;
  if v.status <> 'offen' then
    raise exception 'Diese Einladung wurde schon verwendet.';
  end if;
  if p_accept and v_me is null then
    raise exception 'Bitte zuerst anmelden.';
  end if;
  if v.owner_id = v_me then
    raise exception 'Das ist deine eigene Einladung. Schick den Link an die Person, die du einladen möchtest.';
  end if;
  if v_me is not null and public.invite_already_granted(v) then
    return query select v.kind, coalesce(v.recipe_id, v.list_id, v.owner_id), v.owner_id;
    return;
  end if;

  update public.invites i
  set status = case when p_accept then 'angenommen' else 'abgelehnt' end,
      responded_by = v_me, responded_at = now()
  where i.id = v.id;

  if p_accept then
    if v.kind = 'cookbook' then
      insert into public.cookbook_readers (owner_id, reader_id) values (v.owner_id, v_me) on conflict do nothing;
    elsif v.kind = 'list' then
      insert into public.shopping_list_members (list_id, user_id) values (v.list_id, v_me) on conflict do nothing;
    else
      insert into public.recipe_shares (recipe_id, user_id, owner_id) values (v.recipe_id, v_me, v.owner_id) on conflict do nothing;
    end if;
  end if;

  return query select v.kind, coalesce(v.recipe_id, v.list_id, v.owner_id), v.owner_id;
end $$;

revoke all on function public.respond_invite(uuid, boolean) from public;
grant execute on function public.respond_invite(uuid, boolean) to anon, authenticated;

-- Zieht eine offene eigene Einladung zurück. Der Link zeigt danach "zurückgezogen".
create or replace function public.withdraw_invite(p_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.invites
  set status = 'zurueckgezogen', responded_at = now()
  where id = p_id and owner_id = (select auth.uid()) and status = 'offen';
$$;

revoke all on function public.withdraw_invite(uuid) from public;
grant execute on function public.withdraw_invite(uuid) to authenticated;

-- Einzeln geteilte Rezepte mit Benutzernamen: wem ich was geschickt habe und was ich bekommen habe.
create or replace function public.recipe_share_people()
returns table (recipe_id uuid, user_id uuid, owner_id uuid, user_name text, owner_name text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select s.recipe_id, s.user_id, s.owner_id,
         coalesce(u.username, 'Ohne Namen'), coalesce(o.username, 'Ohne Namen'), s.created_at
  from public.recipe_shares s
  left join public.profiles u on u.user_id = s.user_id
  left join public.profiles o on o.user_id = s.owner_id
  where s.owner_id = (select auth.uid()) or s.user_id = (select auth.uid());
$$;

revoke all on function public.recipe_share_people() from public;
grant execute on function public.recipe_share_people() to authenticated;
