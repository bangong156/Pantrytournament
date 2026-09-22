-- Apply in Supabase before deploying the dashboard deletion button.
-- Re-runnable; deletion itself is atomic and available only to admins.
begin;

create table if not exists public.tournament_deletion_audit (
  id bigint generated always as identity primary key,
  tournament_id uuid not null,
  tournament_name text not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now()
);
alter table public.tournament_deletion_audit enable row level security;
revoke all on public.tournament_deletion_audit from public, anon, authenticated;

-- Shared player records and notes survive. A deleted tournament cannot remain
-- as the flag's foreign-key target, so detach only its tournament reference.
do $$
begin
  if to_regclass('public.player_flags') is not null then
    alter table public.player_flags alter column tournament_id drop not null;
  end if;
end $$;

-- No browser client may delete a tournament directly, regardless of old RLS policies.
revoke delete on public.tournaments from public, anon, authenticated;

create or replace function public.delete_tournament(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
    where id = auth.uid() and lower(role::text) = 'admin'
  ) then
    raise exception 'Admin permission required' using errcode = '42501';
  end if;

  select name into v_name from public.tournaments
  where id = p_tournament_id for update;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;

  if to_regclass('public.player_flags') is not null then
    update public.player_flags set tournament_id = null
    where tournament_id = p_tournament_id;
  end if;
  if to_regclass('public.tournament_followers') is not null then
    execute 'delete from public.tournament_followers where tournament_id = $1'
      using p_tournament_id;
  end if;

  delete from public.referee_live_actions where match_id in
    (select id from public.matches where tournament_id = p_tournament_id)
    or referee_session_id in
    (select id from public.referee_sessions where tournament_id = p_tournament_id);
  delete from public.referee_score_logs where tournament_id = p_tournament_id;
  delete from public.referee_sessions where tournament_id = p_tournament_id;
  delete from public.referee_access_codes where tournament_id = p_tournament_id;
  delete from public.mlp_games where match_id in
    (select id from public.matches where tournament_id = p_tournament_id);
  delete from public.group_teams where group_id in
    (select id from public.groups where tournament_id = p_tournament_id);
  delete from public.team_members where team_id in
    (select id from public.teams where tournament_id = p_tournament_id);
  delete from public.matches where tournament_id = p_tournament_id;
  delete from public.groups where tournament_id = p_tournament_id;
  delete from public.teams where tournament_id = p_tournament_id;
  delete from public.mlp_slots where tournament_id = p_tournament_id;
  delete from public.mlp_configs where tournament_id = p_tournament_id;
  delete from public.tournaments where id = p_tournament_id;

  insert into public.tournament_deletion_audit
    (tournament_id, tournament_name, deleted_by)
  values (p_tournament_id, v_name, auth.uid());
end;
$$;

revoke all on function public.delete_tournament(uuid) from public, anon;
grant execute on function public.delete_tournament(uuid) to authenticated;

commit;
