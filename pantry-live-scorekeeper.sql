-- Apply after pantry-referee-hardening.sql. No production changes occur until run in Supabase.
-- Existing match scores and referee sessions are retained.
begin;

alter table public.matches add column if not exists started_at timestamptz;
alter table public.matches add column if not exists score_target integer not null default 11;
alter table public.matches add column if not exists win_by_two boolean not null default true;
alter table public.matches add column if not exists score_version bigint not null default 0;
do $$
declare
  v_auth_insert boolean := has_table_privilege('authenticated','public.matches','INSERT');
  v_auth_update boolean := has_table_privilege('authenticated','public.matches','UPDATE');
  v_auth_delete boolean := has_table_privilege('authenticated','public.matches','DELETE');
begin
  revoke insert, update, delete on public.matches from public, anon;
  if v_auth_insert then grant insert on public.matches to authenticated; end if;
  if v_auth_update then grant update on public.matches to authenticated; end if;
  if v_auth_delete then grant delete on public.matches to authenticated; end if;
end $$;

-- Preserve every previously permitted match status while adding playing.
do $$
declare v_check record;
begin
  for v_check in
    select c.conname, pg_get_expr(c.conbin, c.conrelid) as expression
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'status'
    where c.conrelid = 'public.matches'::regclass and c.contype = 'c'
      and a.attnum = any(c.conkey)
  loop
    if position('playing' in v_check.expression) = 0 then
      execute format('alter table public.matches drop constraint %I', v_check.conname);
      execute format('alter table public.matches add constraint %I check ((%s) or status = %L)',
                     v_check.conname, v_check.expression, 'playing');
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.matches'::regclass
                   and conname = 'matches_live_score_target_check') then
    alter table public.matches add constraint matches_live_score_target_check
      check (score_target in (11, 15));
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.matches'::regclass
                   and conname = 'matches_live_score_version_check') then
    alter table public.matches add constraint matches_live_score_version_check
      check (score_version >= 0);
  end if;
end $$;

create unique index if not exists matches_one_live_per_group_idx
  on public.matches(tournament_id, group_id)
  where status = 'playing' and stage = 'group';

-- A repeated request ID cannot count the same tap twice.
create table if not exists public.referee_live_actions (
  id uuid primary key,
  referee_session_id uuid not null references public.referee_sessions(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.referee_live_actions enable row level security;
revoke all on public.referee_live_actions from public, anon, authenticated;

-- Internal snapshot used only by the scoped RPCs below.
create or replace function public._referee_live_snapshot(p_match_id uuid)
returns jsonb language sql stable security definer
set search_path = public as $$
  select jsonb_build_object(
    'match_id', m.id, 'match_code', m.match_code, 'group_name', g.name,
    'team1_name', a.name, 'team2_name', b.name,
    'team1_score', coalesce(m.team1_score, 0),
    'team2_score', coalesce(m.team2_score, 0),
    'score_target', m.score_target, 'win_by_two', m.win_by_two,
    'version', m.score_version, 'status', m.status,
    'started_at', m.started_at,
    'can_finish', greatest(coalesce(m.team1_score,0), coalesce(m.team2_score,0)) >= m.score_target
      and abs(coalesce(m.team1_score,0) - coalesce(m.team2_score,0)) >=
          case when m.win_by_two then 2 else 1 end,
    'winner_name', case when coalesce(m.team1_score,0) > coalesce(m.team2_score,0)
                        then a.name else b.name end
  )
  from public.matches m
  join public.groups g on g.id = m.group_id and g.tournament_id = m.tournament_id
  join public.teams a on a.id = m.team1_id and a.tournament_id = m.tournament_id
  join public.teams b on b.id = m.team2_id and b.tournament_id = m.tournament_id
  where m.id = p_match_id;
$$;

create or replace function public._referee_live_allowed(p_tournament_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from public.tournaments t
                 where t.id = p_tournament_id and t.format = 'doubles')
    or exists (select 1 from public.tournaments t
               join public.mlp_configs c on c.tournament_id = t.id
               where t.id = p_tournament_id and t.format = 'mlp'
                 and (c.style = 'mini' or c.members_per_team = 3 or
                      (select count(*) from public.mlp_slots x where x.tournament_id = t.id) = 3));
$$;

-- Returns the single match currently playing in this referee's group.
create or replace function public.referee_live_state(p_session_token uuid)
returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare v_session public.referee_sessions%rowtype; v_match_id uuid;
begin
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.id into v_match_id from public.matches m
  where m.status = 'playing' and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id
    and m.stage = 'group' and public._referee_live_allowed(m.tournament_id) limit 1;
  if v_match_id is null then return null; end if;
  return public._referee_live_snapshot(v_match_id);
end;
$$;

create or replace function public.referee_live_start(
  p_session_token uuid, p_match_id uuid,
  p_score_target integer, p_win_by_two boolean
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_group_name text;
begin
  if p_score_target not in (11,15) or p_score_target is null or p_win_by_two is null then
    raise exception 'Choose an 11 or 15 point target and win-by-2 setting';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  -- Serialize starts in the group, including starts from different devices.
  perform pg_advisory_xact_lock(hashtextextended(v_session.group_id::text, 71513));
  if not exists (
    select 1 from public.referee_sessions s
    join public.referee_access_codes c on c.id = s.access_code_id
      and c.tournament_id = s.tournament_id and c.group_id = s.group_id
    where s.id = v_session.id and s.active and s.expires_at > now()
      and c.active and (c.expires_at is null or c.expires_at > now())
  ) then raise exception 'Referee access expired or revoked'; end if;
  if exists (select 1 from public.matches m
             where m.tournament_id = v_session.tournament_id and m.group_id = v_session.group_id
               and m.stage = 'group' and m.status = 'playing' and m.id <> p_match_id) then
    raise exception 'Finish the active match before starting another';
  end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
  if not public._referee_live_allowed(v_match.tournament_id) then
    raise exception 'Scorekeeper is only for Doubles and MLP Mini';
  end if;
  if v_match.status = 'completed' then raise exception 'This match is already completed'; end if;
  if v_match.status = 'playing' then
    return public._referee_live_snapshot(v_match.id);
  end if;
  if v_match.status = 'scheduled' then
    if coalesce(v_match.team1_score,0) < 0 or coalesce(v_match.team2_score,0) < 0 then
      raise exception 'Existing score cannot be negative';
    end if;
    update public.matches set status = 'playing', started_at = now(),
      team1_score = coalesce(team1_score,0), team2_score = coalesce(team2_score,0),
      score_target = p_score_target, win_by_two = p_win_by_two,
      winner_id = null, completed_at = null, score_version = score_version + 1
    where id = v_match.id;
  else
    raise exception 'This match cannot be started';
  end if;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code,
     referee_name, action, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name, 'live_start',
          v_match.team1_score, v_match.team2_score,
          coalesce(v_match.team1_score,0), coalesce(v_match.team2_score,0));
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
  return public._referee_live_snapshot(v_match.id);
end;
$$;

create or replace function public.referee_live_adjust(
  p_session_token uuid, p_match_id uuid, p_team integer, p_delta integer,
  p_expected_version bigint, p_expected_team1_score integer,
  p_expected_team2_score integer, p_action_id uuid
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_action public.referee_live_actions%rowtype;
  v_inserted uuid;
  v_new1 integer;
  v_new2 integer;
  v_group_name text;
begin
  if p_team not in (1,2) or p_team is null or p_delta not in (-1,1)
     or p_delta is null or p_action_id is null or p_expected_version is null
     or p_expected_team1_score is null or p_expected_team2_score is null then
    raise exception 'Invalid score action';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id and m.stage = 'group'
    and m.status = 'playing'
  for update;
  if v_match.id is null then raise exception 'No active match assigned to this referee'; end if;
  if not public._referee_live_allowed(v_match.tournament_id) then
    raise exception 'Scorekeeper is only for Doubles and MLP Mini';
  end if;
  select * into v_action from public.referee_live_actions where id = p_action_id;
  if v_action.id is not null then
    if v_action.referee_session_id <> v_session.id or v_action.match_id <> v_match.id then
      raise exception 'Action ID belongs to another match';
    end if;
    return public._referee_live_snapshot(v_match.id);
  end if;
  if v_match.score_version is distinct from p_expected_version
     or coalesce(v_match.team1_score,0) is distinct from p_expected_team1_score
     or coalesce(v_match.team2_score,0) is distinct from p_expected_team2_score then
    return public._referee_live_snapshot(v_match.id) || jsonb_build_object('stale',true);
  end if;
  v_new1 := coalesce(v_match.team1_score,0) + case when p_team = 1 then p_delta else 0 end;
  v_new2 := coalesce(v_match.team2_score,0) + case when p_team = 2 then p_delta else 0 end;
  if v_new1 < 0 or v_new2 < 0 then raise exception 'Score cannot be negative'; end if;
  insert into public.referee_live_actions(id, referee_session_id, match_id)
  values (p_action_id, v_session.id, v_match.id)
  on conflict (id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_action from public.referee_live_actions where id = p_action_id;
    if v_action.referee_session_id <> v_session.id or v_action.match_id <> v_match.id then
      raise exception 'Action ID belongs to another match';
    end if;
    return public._referee_live_snapshot(v_match.id);
  end if;
  update public.matches set team1_score = v_new1, team2_score = v_new2,
    score_version = score_version + 1 where id = v_match.id;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code,
     referee_name, action, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name,
          case when p_delta = 1 then 'live_plus' else 'live_minus' end,
          v_match.team1_score, v_match.team2_score, v_new1, v_new2);
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
  return public._referee_live_snapshot(v_match.id);
end;
$$;

create or replace function public.referee_live_finish(
  p_session_token uuid, p_match_id uuid, p_expected_version bigint,
  p_expected_team1_score integer, p_expected_team2_score integer
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_winner uuid;
  v_group_name text;
begin
  if p_expected_version is null or p_expected_team1_score is null
     or p_expected_team2_score is null then raise exception 'Missing score state'; end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id and m.stage = 'group'
    and m.status = 'playing'
  for update;
  if v_match.id is null then raise exception 'No active match assigned to this referee'; end if;
  if not public._referee_live_allowed(v_match.tournament_id) then
    raise exception 'Scorekeeper is only for Doubles and MLP Mini';
  end if;
  if v_match.score_version is distinct from p_expected_version
     or coalesce(v_match.team1_score,0) is distinct from p_expected_team1_score
     or coalesce(v_match.team2_score,0) is distinct from p_expected_team2_score then
    return public._referee_live_snapshot(v_match.id) || jsonb_build_object('stale',true);
  end if;
  if greatest(coalesce(v_match.team1_score,0),coalesce(v_match.team2_score,0)) < v_match.score_target
     or abs(coalesce(v_match.team1_score,0)-coalesce(v_match.team2_score,0)) <
        case when v_match.win_by_two then 2 else 1 end then
    raise exception 'Score does not satisfy the finishing rule';
  end if;
  v_winner := case when v_match.team1_score > v_match.team2_score
                   then v_match.team1_id else v_match.team2_id end;
  update public.matches set status = 'completed', winner_id = v_winner,
    completed_at = now(), team1_score = v_match.team1_score,
    team2_score = v_match.team2_score, score_version = score_version + 1
  where id = v_match.id;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code,
     referee_name, action, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name, 'live_finish',
          v_match.team1_score, v_match.team2_score,
          v_match.team1_score, v_match.team2_score);
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
  return public._referee_live_snapshot(v_match.id);
end;
$$;

-- The legacy aggregate RPC remains available only to correct completed scores.
-- It cannot bypass the explicit finish flow for a scheduled/playing match.
create or replace function public.referee_submit_score(
  p_session_token uuid, p_match_id uuid,
  p_team1_score integer, p_team2_score integer
)
returns void language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_format text;
  v_winner uuid;
  v_group_name text;
begin
  if p_team1_score is null or p_team2_score is null or
     p_team1_score < 0 or p_team2_score < 0 or p_team1_score = p_team2_score then
    raise exception 'Invalid score';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
  if v_match.status <> 'completed' then
    raise exception 'Use Scorekeeper Mode to start and finish this match';
  end if;
  select t.format into v_format from public.tournaments t where t.id = v_match.tournament_id;
  if not coalesce(v_format = 'doubles' or (
    v_format = 'mlp' and exists (
      select 1 from public.mlp_configs c where c.tournament_id = v_match.tournament_id
        and (c.style = 'mini' or c.members_per_team = 3 or
             (select count(*) from public.mlp_slots x where x.tournament_id = c.tournament_id) = 3)
    )
  ), false) then raise exception 'Aggregate scoring is only allowed for Doubles and MLP Mini'; end if;
  v_winner := case when p_team1_score > p_team2_score then v_match.team1_id
                   else v_match.team2_id end;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code, referee_name,
     action, old_team1_score, old_team2_score, new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name, 'edit_score',
          v_match.team1_score, v_match.team2_score, p_team1_score, p_team2_score);
  update public.matches set team1_score = p_team1_score, team2_score = p_team2_score,
    winner_id = v_winner, completed_at = coalesce(completed_at, now()),
    score_version = score_version + 1
  where id = v_match.id;
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
end;
$$;

revoke all on function public._referee_live_snapshot(uuid) from public, anon, authenticated;
revoke all on function public._referee_live_allowed(uuid) from public, anon, authenticated;
revoke all on function public.referee_live_state(uuid) from public;
revoke all on function public.referee_live_start(uuid,uuid,integer,boolean) from public;
revoke all on function public.referee_live_adjust(uuid,uuid,integer,integer,bigint,integer,integer,uuid) from public;
revoke all on function public.referee_live_finish(uuid,uuid,bigint,integer,integer) from public;
grant execute on function public.referee_live_state(uuid) to anon, authenticated;
grant execute on function public.referee_live_start(uuid,uuid,integer,boolean) to anon, authenticated;
grant execute on function public.referee_live_adjust(uuid,uuid,integer,integer,bigint,integer,integer,uuid) to anon, authenticated;
grant execute on function public.referee_live_finish(uuid,uuid,bigint,integer,integer) to anon, authenticated;
commit;
