-- Benachrichtigungen (Glocke oben rechts). Einmal im Supabase-Dashboard unter "SQL Editor"
-- ausführen (nach einladungen.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Wird eine Einladung angenommen, bekommt der Absender eine Benachrichtigung. Gelesene
-- verschwinden nach 7 Tagen, ungelesene bleiben, bis man sie gesehen hat.

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade, -- Empfänger
  kind        text not null check (kind in ('invite_accepted', 'share_back')),
  actor_id    uuid references auth.users (id) on delete set null,         -- wer etwas getan hat
  invite_id   uuid references public.invites (id) on delete cascade,
  target_kind text check (target_kind in ('recipe', 'cookbook', 'list')),
  target_id   uuid,
  title       text,                                                       -- Rezept- oder Listenname zum Zeitpunkt
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

-- Jeder sieht nur seine eigenen. Anlegen, ändern und löschen geht nur über die Funktionen
-- unten, damit sich niemand gefälschte Benachrichtigungen schicken kann.
drop policy if exists "Eigene Benachrichtigungen sehen" on public.notifications;
create policy "Eigene Benachrichtigungen sehen" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));

-- Nimmt jemand eine Einladung an, erfährt es der Absender.
create or replace function public.notify_invite_accepted()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'angenommen' and old.status = 'offen' and new.responded_by is not null then
    insert into public.notifications (user_id, kind, actor_id, invite_id, target_kind, target_id, title)
    values (
      new.owner_id, 'invite_accepted', new.responded_by, new.id, new.kind,
      coalesce(new.recipe_id, new.list_id, new.owner_id),
      coalesce((select r.title from public.recipes r where r.id = new.recipe_id),
               (select l.name from public.shopping_lists l where l.id = new.list_id))
    );
  end if;
  return new;
end $$;

drop trigger if exists notify_invite_accepted on public.invites;
create trigger notify_invite_accepted after update of status on public.invites
  for each row execute function public.notify_invite_accepted();

-- Die eigenen Benachrichtigungen, neueste zuerst. Räumt vorher gelesene auf, die älter
-- als 7 Tage sind; so braucht es keinen zeitgesteuerten Job.
create or replace function public.my_notifications()
returns table (id uuid, kind text, actor_name text, invite_id uuid, invite_status text,
               target_kind text, target_id uuid, title text, created_at timestamptz, read_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  delete from public.notifications n
  where n.user_id = auth.uid() and n.read_at < now() - interval '7 days';
  return query
    select n.id, n.kind, coalesce(p.username, 'Jemand'), n.invite_id, i.status,
           n.target_kind, n.target_id, n.title, n.created_at, n.read_at
    from public.notifications n
    left join public.profiles p on p.user_id = n.actor_id
    left join public.invites i on i.id = n.invite_id
    where n.user_id = auth.uid()
    order by n.created_at desc
    limit 100;
end $$;

revoke all on function public.my_notifications() from public;
grant execute on function public.my_notifications() to authenticated;

-- Markiert eigene Benachrichtigungen als gelesen.
create or replace function public.mark_notifications_read(p_ids uuid[])
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications
  set read_at = now()
  where user_id = (select auth.uid()) and id = any (p_ids) and read_at is null;
$$;

revoke all on function public.mark_notifications_read(uuid[]) from public;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- Live-Aktualisierung, damit die Zahl an der Glocke sofort stimmt.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
