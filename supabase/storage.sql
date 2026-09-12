-- ===========================================================================
-- SlurpQuest cloud passport — phase 2: photo storage
--
-- Run once in the Supabase SQL editor, like schema.sql. Idempotent.
--
-- If the CREATE POLICY statements fail with "must be owner of table objects"
-- (newer projects lock the storage schema), create the same three policies in
-- the dashboard instead: Storage -> photos bucket -> Policies. The bucket
-- INSERT below should still work; if not, create the bucket in the dashboard
-- with: public = yes, max file size 500 KB, allowed MIME type image/jpeg.
--
-- Trust model:
--   * The bucket is public-read: photo URLs are shareable links served from
--     the CDN, which draws on the separate cached-egress quota.
--   * Server-side enforcement lives in the bucket config (size + MIME type),
--     not in the client's canvas downscale, which is just a courtesy.
--   * Writes are confined to your own folder: the first path segment must be
--     your uid, so nobody can overwrite or delete another traveler's photos.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 512000, array['image/jpeg'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The Storage API checks SELECT before it will honour an UPDATE (overwrite on
-- photo edit) or DELETE, so owners need read access to their own folder even
-- though public serving happens via the public-bucket URL without any policy.
drop policy if exists "photos: read own folder" on storage.objects;
create policy "photos: read own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos: insert own folder" on storage.objects;
create policy "photos: insert own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos: update own folder" on storage.objects;
create policy "photos: update own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos: delete own folder" on storage.objects;
create policy "photos: delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
