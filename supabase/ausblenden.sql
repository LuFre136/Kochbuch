-- Geteilte Kochbücher ausblenden. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach teilen.sql und benutzername.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Ein ausgeblendetes Kochbuch bleibt lesbar, die App lässt es aber bei "Was kochen?",
-- der Saison und beim Kombinieren weg. Die Einstellung gehört dem Leser; der Besitzer
-- merkt davon nichts.

alter table public.cookbook_readers add column if not exists hidden boolean not null default false;

-- Leser dürfen nur diese eine Spalte ihrer eigenen Zeile ändern. Deshalb keine
-- Update-Regel auf der Tabelle, sondern diese Funktion.
create or replace function public.set_cookbook_hidden(p_owner uuid, p_hidden boolean)
returns void
language sql security definer set search_path = ''
as $$
  update public.cookbook_readers
  set hidden = coalesce(p_hidden, false)
  where owner_id = p_owner and reader_id = (select auth.uid());
$$;

revoke all on function public.set_cookbook_hidden(uuid, boolean) from public;
grant execute on function public.set_cookbook_hidden(uuid, boolean) to authenticated;

-- Freigaben mit Benutzernamen, jetzt auch mit der Spalte hidden.
drop function if exists public.cookbook_people();
create function public.cookbook_people()
returns table (owner_id uuid, reader_id uuid, owner_name text, reader_name text, created_at timestamptz, hidden boolean)
language sql stable security definer set search_path = ''
as $$
  select c.owner_id, c.reader_id,
         coalesce(o.username, 'Ohne Namen'), coalesce(r.username, 'Ohne Namen'), c.created_at,
         -- Ob ein Leser ausgeblendet hat, geht nur ihn selbst etwas an.
         case when c.reader_id = (select auth.uid()) then c.hidden else false end
  from public.cookbook_readers c
  left join public.profiles o on o.user_id = c.owner_id
  left join public.profiles r on r.user_id = c.reader_id
  where c.owner_id = (select auth.uid()) or c.reader_id = (select auth.uid());
$$;

revoke all on function public.cookbook_people() from public;
grant execute on function public.cookbook_people() to authenticated;
