-- Apply once in Supabase before using Vinh danh. Safe to rerun.
begin;

create table if not exists public.tournament_awards (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  placement integer not null check (placement between 1 and 3),
  team_name text,
  player_names text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (tournament_id, placement),
  constraint tournament_awards_has_name check (
    nullif(btrim(coalesce(team_name, '')), '') is not null or
    nullif(btrim(coalesce(player_names, '')), '') is not null
  )
);

alter table public.tournament_awards enable row level security;

drop policy if exists "public read tournament awards" on public.tournament_awards;
create policy "public read tournament awards" on public.tournament_awards
  for select to anon, authenticated using (true);

drop policy if exists "admin insert tournament awards" on public.tournament_awards;
create policy "admin insert tournament awards" on public.tournament_awards
  for insert to authenticated with check (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and lower(p.role::text) = 'admin')
  );

drop policy if exists "admin update tournament awards" on public.tournament_awards;
create policy "admin update tournament awards" on public.tournament_awards
  for update to authenticated
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and lower(p.role::text) = 'admin'))
  with check (exists (select 1 from public.profiles p
                      where p.id = auth.uid() and lower(p.role::text) = 'admin'));

drop policy if exists "admin delete tournament awards" on public.tournament_awards;
create policy "admin delete tournament awards" on public.tournament_awards
  for delete to authenticated using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and lower(p.role::text) = 'admin')
  );

revoke all on public.tournament_awards from public, anon, authenticated;
grant select on public.tournament_awards to anon, authenticated;
grant insert, update, delete on public.tournament_awards to authenticated;
commit;
