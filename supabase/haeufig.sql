-- Häufig gekaufte Artikel je Einkaufsliste. Einmal im Supabase-Dashboard unter "SQL Editor"
-- ausführen (nach einkauf.sql). Kann gefahrlos mehrfach ausgeführt werden.
-- Jedes Abhaken zählt mit; die Liste zeigt oben die Artikel, die am häufigsten gekauft werden.
-- Wer eine Liste mitbearbeitet, sieht dieselben Vorschläge.

create table if not exists public.shopping_frequent (
  list_id     uuid not null references public.shopping_lists (id) on delete cascade,
  key         text not null check (char_length(key) between 1 and 200),
  name        text not null check (char_length(name) between 1 and 200),
  amount      numeric,
  unit        text not null default '',
  count       integer not null default 1,
  last_bought timestamptz not null default now(),
  hidden      boolean not null default false,
  primary key (list_id, key)
);

alter table public.shopping_frequent enable row level security;

drop policy if exists "Häufige Artikel der eigenen Listen" on public.shopping_frequent;
create policy "Häufige Artikel der eigenen Listen" on public.shopping_frequent
  for all to authenticated
  using (public.can_use_list(list_id)) with check (public.can_use_list(list_id));

-- Zählt einen Kauf: legt den Artikel an oder erhöht seinen Zähler und merkt die Menge.
-- Läuft mit den Rechten des Aufrufers, die Regel oben gilt also auch hier.
create or replace function public.count_purchase(p_list uuid, p_key text, p_name text, p_amount numeric, p_unit text)
returns void
language sql security invoker set search_path = ''
as $$
  insert into public.shopping_frequent (list_id, key, name, amount, unit)
  values (p_list, p_key, p_name, p_amount, coalesce(p_unit, ''))
  on conflict (list_id, key) do update
    set count = public.shopping_frequent.count + 1,
        name = excluded.name, amount = excluded.amount, unit = excluded.unit,
        last_bought = now();
$$;

grant execute on function public.count_purchase(uuid, text, text, numeric, text) to authenticated;
