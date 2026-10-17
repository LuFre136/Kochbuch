-- Nährwerte für Rezepte. Einmal im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Kann gefahrlos mehrfach ausgeführt werden.
-- Format: { "kcal": 540, "protein": 25.4, "fat": 27.7, "carbs": 46.6, "sugar": 5, "fiber": 3, "salt": 1.2, "per": "Portion" }
-- (kcal bzw. Gramm; per ist "Portion" oder "100 g").

alter table public.recipes add column if not exists nutrition jsonb;
