-- Apply after the existing tournament migrations. Public event copy and posters.
begin;

create table if not exists public.tournament_info (
  tournament_id uuid primary key references public.tournaments(id) on delete cascade,
  content text not null default '',
  prize_information text not null default '',
  rules text not null default '',
  poster_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tournament_info_poster_path_check check (
    poster_path is null or poster_path ~
      ('^' || tournament_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$')
  )
);

alter table public.tournament_info enable row level security;
drop policy if exists "public read tournament info" on public.tournament_info;
create policy "public read tournament info" on public.tournament_info
  for select to anon, authenticated using (true);
drop policy if exists "admin insert tournament info" on public.tournament_info;
create policy "admin insert tournament info" on public.tournament_info
  for insert to authenticated with check (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and lower(p.role::text) = 'admin')
  );
drop policy if exists "admin update tournament info" on public.tournament_info;
create policy "admin update tournament info" on public.tournament_info
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid()
                 and lower(p.role::text) = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid()
                      and lower(p.role::text) = 'admin'));
drop policy if exists "admin delete tournament info" on public.tournament_info;
create policy "admin delete tournament info" on public.tournament_info
  for delete to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and lower(p.role::text) = 'admin')
  );
revoke all on public.tournament_info from public, anon, authenticated;
grant select on public.tournament_info to anon, authenticated;
grant insert, update, delete on public.tournament_info to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tournament-posters', 'tournament-posters', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read tournament posters" on storage.objects;
create policy "public read tournament posters" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'tournament-posters');
drop policy if exists "admin upload tournament posters" on storage.objects;
create policy "admin upload tournament posters" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'tournament-posters'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'
    and exists (select 1 from public.profiles p where p.id = auth.uid()
                and lower(p.role::text) = 'admin')
    and exists (select 1 from public.tournaments t
                where t.id::text = split_part(name, '/', 1))
  );
drop policy if exists "admin delete tournament posters" on storage.objects;
create policy "admin delete tournament posters" on storage.objects
  for delete to authenticated using (
    bucket_id = 'tournament-posters'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'
    and exists (select 1 from public.profiles p where p.id = auth.uid()
                and lower(p.role::text) = 'admin')
  );

commit;
