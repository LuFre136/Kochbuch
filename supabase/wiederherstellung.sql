-- Wiederherstellungscode: Passwort zurücksetzen ohne Mail. Einmal im Supabase-Dashboard unter
-- "SQL Editor" ausführen (nach namen.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Jeder kann sich einen Code erstellen und aufschreiben. Mit Benutzername oder E-Mail, Code und
-- neuem Passwort setzt man das Passwort selbst neu und bekommt dabei gleich einen neuen Code.
-- Gespeichert wird nur ein Hash des Codes; niemand, auch nicht der Besitzer, kann ihn auslesen.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.recovery_codes (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  code_hash    text not null,
  failed       integer not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);

-- Keine Regeln: Die App kommt nur über die Funktionen unten an die Tabelle.
alter table public.recovery_codes enable row level security;

-- 16 Zeichen aus 31 gut lesbaren (ohne 0/O, 1/I/L), angezeigt in Vierergruppen: XXXX-XXXX-XXXX-XXXX.
create or replace function public.new_recovery_code()
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  v_chars constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(16);
  v_code text := '';
begin
  -- Der Rest der Division ist nicht ganz gleichverteilt; bei 16 Stellen (rund 79 Bit) ist das egal.
  for i in 0..15 loop
    v_code := v_code || substr(v_chars, get_byte(v_bytes, i) % length(v_chars) + 1, 1);
    if i in (3, 7, 11) then v_code := v_code || '-'; end if;
  end loop;
  return v_code;
end $$;

revoke all on function public.new_recovery_code() from public, anon, authenticated;

-- Eingaben vergleichbar machen: Groß, ohne Leerzeichen und Striche.
create or replace function public.clean_recovery_code(p_code text)
returns text
language sql immutable set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- Neuer Code für das angemeldete Konto; ein alter verliert damit seine Gültigkeit.
create or replace function public.create_recovery_code()
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_code text := public.new_recovery_code();
begin
  if auth.uid() is null then raise exception 'Bitte zuerst anmelden.'; end if;
  insert into public.recovery_codes (user_id, code_hash)
  values (auth.uid(), extensions.crypt(public.clean_recovery_code(v_code), extensions.gen_salt('bf')))
  on conflict (user_id) do update
    set code_hash = excluded.code_hash, failed = 0, locked_until = null, created_at = now();
  return v_code;
end $$;

revoke all on function public.create_recovery_code() from public, anon;
grant execute on function public.create_recovery_code() to authenticated;

-- Wann der Code des angemeldeten Kontos erstellt wurde, oder null, wenn es keinen hat.
create or replace function public.my_recovery_code()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select created_at from public.recovery_codes where user_id = (select auth.uid());
$$;

revoke all on function public.my_recovery_code() from public, anon;
grant execute on function public.my_recovery_code() to authenticated;

-- Passwort mit dem Code neu setzen. Auch ohne Anmeldung aufrufbar. p_login ist Benutzername
-- oder E-Mail. Liefert {"code": neuer Code, "email": E-Mail zum Anmelden}. Nach fünf falschen Versuchen ist das Konto für eine
-- Viertelstunde gesperrt. null heißt: Name oder Code stimmt nicht (ohne zu verraten, was).
create or replace function public.reset_password_with_code(p_login text, p_code text, p_password text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_login text := btrim(regexp_replace(coalesce(p_login, ''), '\s+', ' ', 'g'));
  v_user uuid;
  v_row public.recovery_codes;
  v_code text;
  v_email text;
begin
  if char_length(coalesce(p_password, '')) < 6 then
    raise exception 'Das Passwort muss mindestens 6 Zeichen haben.';
  end if;
  if position('@' in v_login) > 0 then
    select id into v_user from auth.users where lower(email) = lower(v_login);
  else
    select user_id into v_user from public.profiles where lower(username) = lower(v_login);
  end if;
  select * into v_row from public.recovery_codes where user_id = v_user for update;
  if v_row.user_id is null then
    return null; -- wie ein falscher Code: verrät nicht, ob es das Konto gibt
  end if;
  if v_row.locked_until > now() then
    raise exception 'Zu viele falsche Versuche. Bitte warte eine Viertelstunde.';
  end if;
  if v_row.code_hash <> extensions.crypt(public.clean_recovery_code(p_code), v_row.code_hash) then
    update public.recovery_codes
      set failed = failed + 1,
          locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' end
      where user_id = v_user;
    -- Kein "raise", sonst würde der Zähler mit zurückgerollt. null heißt: stimmt nicht.
    return null;
  end if;
  update auth.users
    set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
        updated_at = now()
    where id = v_user
    returning email into v_email;
  -- Wer das Passwort neu setzt, wird auf allen anderen Geräten abgemeldet.
  delete from auth.sessions where user_id = v_user;
  v_code := public.new_recovery_code();
  update public.recovery_codes
    set code_hash = extensions.crypt(public.clean_recovery_code(v_code), extensions.gen_salt('bf')),
        failed = 0, locked_until = null, created_at = now()
    where user_id = v_user;
  return jsonb_build_object('code', v_code, 'email', v_email);
end $$;

revoke all on function public.reset_password_with_code(text, text, text) from public;
grant execute on function public.reset_password_with_code(text, text, text) to anon, authenticated;
