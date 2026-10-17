-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Ergänzt "zuletzt gekocht" an den Rezepten. Das Datum setzt die App selbst, sobald ein
-- eingeplanter Tag vorbei ist und der Eintrag aus dem Essensplan fällt.

alter table public.recipes add column if not exists last_cooked date;
