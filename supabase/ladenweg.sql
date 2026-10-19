-- Ladenweg: in welcher Reihenfolge die Kategorien (Obst, Gemüse …) in einem Einkaufsort
-- liegen. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen (nach orte.sql).
-- Kann gefahrlos mehrfach ausgeführt werden. null = die vorgegebene Reihenfolge.
alter table public.shopping_places add column if not exists category_order text[];
