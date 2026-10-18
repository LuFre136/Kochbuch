-- Anzeigename für Zutaten unter "Verwalten" → "Zutaten". Einmal im Supabase-Dashboard unter
-- "SQL Editor" ausführen (nach kategorien.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- key ist der zusammengefasste Name ("tomat" für "Tomaten" und "Tomate, gewürfelt"); name ist
-- die Schreibweise, unter der die Zutat in der Liste steht. Ohne diese Spalte zeigt die App
-- den Namen aus den Rezepten oder den Schlüssel.

alter table public.ingredient_categories add column if not exists name text
  check (name is null or char_length(name) between 1 and 200);
