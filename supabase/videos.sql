-- Speicherordner für Videos, aus denen ein Rezept gelesen werden soll (z. B. gespeicherte
-- TikToks). Einmal im Supabase-Dashboard unter "SQL Editor" ausführen. Kann gefahrlos
-- mehrfach ausgeführt werden. Die Videos liegen nur kurz hier: Die Edge Function löscht
-- sie, sobald Gemini sie ausgewertet hat. Privat, jeder nur im eigenen Ordner.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('import-videos', 'import-videos', false, 52428800,
        array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Eigene Import-Videos sehen" on storage.objects;
create policy "Eigene Import-Videos sehen" on storage.objects
  for select to authenticated
  using (bucket_id = 'import-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Import-Videos in eigenen Ordner hochladen" on storage.objects;
create policy "Import-Videos in eigenen Ordner hochladen" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'import-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Eigene Import-Videos löschen" on storage.objects;
create policy "Eigene Import-Videos löschen" on storage.objects
  for delete to authenticated
  using (bucket_id = 'import-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
