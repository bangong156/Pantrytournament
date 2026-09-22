-- Apply after the existing poster migrations. Storage writes depend only on Admin role.
begin;

drop policy if exists "admin upload tournament posters" on storage.objects;
drop policy if exists "admin delete tournament posters" on storage.objects;

drop function if exists public._tournament_poster_write_allowed(text, boolean);
drop function if exists public._tournament_poster_admin();

create policy "admin upload tournament posters" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tournament-posters' and (select public.is_admin()));

create policy "admin delete tournament posters" on storage.objects
  for delete to authenticated
  using (bucket_id = 'tournament-posters' and (select public.is_admin()));

commit;
