-- Zurückteilen nach einer angenommenen Kochbuch-Einladung. Einmal im Supabase-Dashboard
-- unter "SQL Editor" ausführen (nach einladungen.sql und benachrichtigungen.sql).
-- Kann gefahrlos mehrfach ausgeführt werden.
--
-- Ben nimmt Annas Kochbuch-Einladung an und wird gefragt, ob er sein eigenes Kochbuch
-- zurückteilen möchte. Sagt er ja, entsteht eine Einladung ohne Link, die direkt an Anna
-- geht. Anna sieht sie in der Glocke und nimmt an oder lehnt ab, genau einmal.

-- Darf ich der Person mein Kochbuch anbieten? Nur wenn ich ihr Kochbuch lese (so kann
-- niemand Fremden ungefragt Angebote schicken), sie meines noch nicht liest und noch
-- kein offenes Angebot von mir hat.
create or replace function public.share_back_possible(p_person uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
     and p_person <> (select auth.uid())
     and exists (select 1 from public.cookbook_readers c
                 where c.owner_id = p_person and c.reader_id = (select auth.uid()))
     and not exists (select 1 from public.cookbook_readers c
                     where c.owner_id = (select auth.uid()) and c.reader_id = p_person)
     and not exists (select 1 from public.invites i
                     where i.kind = 'cookbook' and i.owner_id = (select auth.uid())
                       and i.invitee_id = p_person and i.status = 'offen');
$$;

revoke all on function public.share_back_possible(uuid) from public;
grant execute on function public.share_back_possible(uuid) to authenticated;

-- Bietet der Person das eigene Kochbuch an und meldet es ihr in der Glocke.
create or replace function public.offer_share_back(p_person uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.share_back_possible(p_person) then
    raise exception 'Das Kochbuch lässt sich dieser Person gerade nicht anbieten.';
  end if;
  insert into public.invites (token, kind, owner_id, invitee_id)
  values (null, 'cookbook', auth.uid(), p_person)
  returning id into v_id;
  insert into public.notifications (user_id, kind, actor_id, invite_id, target_kind, target_id)
  values (p_person, 'share_back', auth.uid(), v_id, 'cookbook', auth.uid());
  return v_id;
end $$;

revoke all on function public.offer_share_back(uuid) from public;
grant execute on function public.offer_share_back(uuid) to authenticated;

-- Beantwortet eine Einladung, die direkt an mich ging (ohne Link). Gilt nur einmal und nur
-- für die eingeladene Person. Annehmen trägt mich als Leser ein; der Absender bekommt
-- dann über den Trigger aus benachrichtigungen.sql "angenommen" in seine Glocke.
create or replace function public.respond_direct_invite(p_id uuid, p_accept boolean)
returns table (kind text, target_id uuid, owner_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v public.invites;
begin
  select * into v from public.invites i
  where i.id = p_id and i.invitee_id = auth.uid()
  for update;
  if not found then
    raise exception 'Diese Einladung gibt es nicht.';
  end if;
  if v.status = 'zurueckgezogen' then
    raise exception 'Diese Einladung wurde zurückgezogen.';
  end if;
  if v.status <> 'offen' then
    raise exception 'Diese Einladung hast du schon beantwortet.';
  end if;

  update public.invites i
  set status = case when p_accept then 'angenommen' else 'abgelehnt' end,
      responded_by = auth.uid(), responded_at = now()
  where i.id = v.id;

  if p_accept then
    insert into public.cookbook_readers (owner_id, reader_id) values (v.owner_id, auth.uid()) on conflict do nothing;
  end if;

  update public.notifications n set read_at = coalesce(n.read_at, now())
  where n.invite_id = v.id and n.user_id = auth.uid();

  return query select v.kind, v.owner_id, v.owner_id;
end $$;

revoke all on function public.respond_direct_invite(uuid, boolean) from public;
grant execute on function public.respond_direct_invite(uuid, boolean) to authenticated;

-- Wie in benachrichtigungen.sql, aber unbeantwortete Angebote bleiben stehen, bis
-- jemand reagiert, auch wenn sie schon gelesen sind. Dazu der Name der eingeladenen
-- Person bei eigenen offenen Einladungen ohne Link.
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
  where n.user_id = auth.uid() and n.read_at < now() - interval '7 days'
    and not exists (select 1 from public.invites i where i.id = n.invite_id and i.status = 'offen');
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

-- Namen der Personen, an die meine offenen Einladungen ohne Link gehen.
create or replace function public.invitee_names()
returns table (invite_id uuid, name text)
language sql stable security definer set search_path = ''
as $$
  select i.id, coalesce(p.username, 'Ohne Namen')
  from public.invites i left join public.profiles p on p.user_id = i.invitee_id
  where i.owner_id = (select auth.uid()) and i.invitee_id is not null;
$$;

revoke all on function public.invitee_names() from public;
grant execute on function public.invitee_names() to authenticated;
