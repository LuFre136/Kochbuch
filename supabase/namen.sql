-- Eindeutige Benutzernamen. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen
-- (nach benutzername.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Eindeutig waren die Namen schon (profiles_username_key, ohne Rücksicht auf Groß- und
-- Kleinschreibung). Neu: Der Name wird schon beim Registrieren reserviert, nicht erst beim
-- ersten Anmelden nach der Bestätigungsmail, und die App kann vorher fragen, ob er frei ist.

-- Keine doppelten Leerzeichen, damit "Anna Müller" und "Anna  Müller" nicht zwei Namen sind.
-- "not valid": prüft nur neue und geänderte Namen, alte Einträge bleiben unangetastet.
alter table public.profiles drop constraint if exists profiles_username_single_spaces;
alter table public.profiles add constraint profiles_username_single_spaces
  check (username !~ '\s\s') not valid;

-- Ist ein Name noch frei? Auch ohne Anmeldung aufrufbar (beim Registrieren). Verrät nur
-- ja oder nein, nicht wem ein Name gehört. Der eigene Name gilt als frei.
create or replace function public.username_available(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not exists (
    select 1 from public.profiles p
    where lower(p.username) = lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')))
      and p.user_id is distinct from (select auth.uid())
  );
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- Legt beim Registrieren gleich das Profil mit dem gewünschten Namen an. Ist der Name
-- vergeben oder ungültig, bleibt das Konto ohne Profil; die App fragt dann nach einem Namen.
-- Ein Fehler hier darf die Registrierung nie verhindern.
create or replace function public.reserve_username()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', ''), '\s+', ' ', 'g'));
begin
  if v_name ~ '^[A-Za-z0-9ÄÖÜäöüß ._-]{3,30}$' then
    begin
      insert into public.profiles (user_id, username) values (new.id, v_name) on conflict do nothing;
    exception when others then
      null;
    end;
  end if;
  return new;
end $$;

drop trigger if exists reserve_username on auth.users;
create trigger reserve_username after insert on auth.users
  for each row execute function public.reserve_username();

-- Zur Kontrolle: Konten ohne Benutzernamen. Diese Leute werden beim nächsten Anmelden
-- nach einem Namen gefragt. Eine leere Tabelle ist das erwartete Ergebnis.
select u.email, u.created_at, u.raw_user_meta_data ->> 'username' as gewuenschter_name
from auth.users u
left join public.profiles p on p.user_id = u.id
where p.user_id is null
order by u.created_at;
