-- Apply after pantry-referee-mode.sql and pantry-referee-public-mlp-patch.sql.
-- Idempotent production migration; existing codes, sessions, and scores are retained.
begin;

alter table public.referee_access_codes
  add column if not exists failed_attempts integer not null default 0;
alter table public.referee_access_codes
  add column if not exists locked_until timestamptz;

-- Staff UI needs status, never the bcrypt hash or lockout counters.
revoke select on public.referee_access_codes from public, anon, authenticated;
grant select (id, tournament_id, group_id, active, expires_at, created_at, updated_at)
  on public.referee_access_codes to authenticated;

alter table public.referee_score_logs
  add column if not exists game_order integer;
alter table public.referee_score_logs
  add column if not exists group_name text;
alter table public.referee_score_logs
  add column if not exists match_code text;
alter table public.referee_score_logs
  add column if not exists game_type text;
alter table public.referee_score_logs
  add column if not exists old_game_team1_score integer;
alter table public.referee_score_logs
  add column if not exists old_game_team2_score integer;
alter table public.referee_score_logs
  add column if not exists new_game_team1_score integer;
alter table public.referee_score_logs
  add column if not exists new_game_team2_score integer;

update public.referee_score_logs l set group_name = g.name
from public.groups g where l.group_id = g.id and l.group_name is null;
update public.referee_score_logs l set match_code = m.match_code
from public.matches m where l.match_id = m.id and l.match_code is null;

-- These are the tables read by the public tournament and referee pages.
-- Select policies do not grant any anonymous table writes.
grant usage on schema public to anon, authenticated;
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'tournaments', 'groups', 'teams', 'group_teams', 'matches',
    'mlp_configs', 'mlp_slots', 'mlp_games'
  ] loop
    execute format('drop policy if exists %I on public.%I', 'referee public tournament read', v_table);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)',
                   'referee public tournament read', v_table);
    execute format('grant select on public.%I to anon, authenticated', v_table);
  end loop;
end $$;

-- Staff can still choose a code, while newly generated codes are eight digits.
create or replace function public.set_referee_code(
  p_tournament_id uuid, p_group_id uuid, p_code text,
  p_expires_at timestamptz default null
)
returns uuid language plpgsql security definer
set search_path = public, extensions as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Staff permission required';
  end if;
  if p_code is null or length(trim(p_code)) < 8 then
    raise exception 'Referee code must contain at least 8 characters';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Referee code expiry must be in the future';
  end if;
  if not exists (select 1 from public.groups g
                 where g.id = p_group_id and g.tournament_id = p_tournament_id) then
    raise exception 'Group does not belong to this tournament';
  end if;
  insert into public.referee_access_codes
    (tournament_id, group_id, code_hash, active, expires_at, created_by,
     updated_at, failed_attempts, locked_until)
  values
    (p_tournament_id, p_group_id, crypt(trim(p_code), gen_salt('bf')),
     true, p_expires_at, auth.uid(), now(), 0, null)
  on conflict (tournament_id, group_id) do update set
    code_hash = excluded.code_hash, active = true,
    expires_at = excluded.expires_at, created_by = auth.uid(),
    updated_at = now(), failed_attempts = 0, locked_until = null
  returning id into v_id;
  update public.referee_sessions set active = false
  where tournament_id = p_tournament_id and group_id = p_group_id;
  return v_id;
end;
$$;

-- Wrong guesses return no row so the failed-attempt update is committed.
create or replace function public.claim_referee_access(
  p_tournament_id uuid, p_group_id uuid, p_referee_name text, p_code text
)
returns table (
  session_token uuid, tournament_id uuid, group_id uuid,
  group_name text, referee_name text, expires_at timestamptz
)
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_code public.referee_access_codes%rowtype;
  v_session public.referee_sessions%rowtype;
  v_group_name text;
begin
  if length(trim(coalesce(p_referee_name, ''))) < 2 then
    raise exception 'Please enter referee name';
  end if;
  select * into v_code from public.referee_access_codes c
  where c.tournament_id = p_tournament_id and c.group_id = p_group_id
    and c.active = true and (c.expires_at is null or c.expires_at > now())
  for update;
  if v_code.id is null or v_code.locked_until > now() then return; end if;
  if crypt(trim(coalesce(p_code, '')), v_code.code_hash) <> v_code.code_hash then
    update public.referee_access_codes
    set failed_attempts = case when locked_until is not null and locked_until <= now()
                               then 1 else failed_attempts + 1 end,
        locked_until = case when (case when locked_until is not null and locked_until <= now()
                                        then 1 else failed_attempts + 1 end) >= 10
                            then now() + interval '5 minutes' else null end
    where id = v_code.id;
    return;
  end if;
  select g.name into v_group_name from public.groups g
  where g.id = p_group_id and g.tournament_id = p_tournament_id;
  if v_group_name is null then return; end if;
  update public.referee_access_codes
  set failed_attempts = 0, locked_until = null where id = v_code.id;
  insert into public.referee_sessions
    (access_code_id, tournament_id, group_id, referee_name)
  values (v_code.id, p_tournament_id, p_group_id, trim(p_referee_name))
  returning * into v_session;
  return query select v_session.id, v_session.tournament_id, v_session.group_id,
                      v_group_name, v_session.referee_name, v_session.expires_at;
end;
$$;

-- The server, rather than localStorage, supplies the authorized group.
create or replace function public.get_referee_session(p_session_token uuid)
returns table (
  session_token uuid, tournament_id uuid, group_id uuid,
  group_name text, referee_name text, expires_at timestamptz
)
language sql stable security definer
set search_path = public as $$
  select s.id, s.tournament_id, s.group_id, g.name, s.referee_name, s.expires_at
  from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  join public.groups g on g.id = s.group_id and g.tournament_id = s.tournament_id
  where s.id = p_session_token and s.active = true and s.expires_at > now()
    and c.active = true and (c.expires_at is null or c.expires_at > now());
$$;

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
  where s.id = p_session_token and s.active = true and s.expires_at > now()
    and c.active = true and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
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
          v_match.id, v_match.match_code,
          v_session.referee_name,
          case when v_match.status = 'completed' then 'edit_score' else 'submit_score' end,
          v_match.team1_score, v_match.team2_score, p_team1_score, p_team2_score);
  update public.matches set team1_score = p_team1_score, team2_score = p_team2_score,
    winner_id = v_winner, status = 'completed', completed_at = now()
  where id = v_match.id;
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
end;
$$;

create or replace function public.referee_submit_mlp_game(
  p_session_token uuid, p_match_id uuid, p_game_order integer,
  p_game_type text, p_team1_score integer, p_team2_score integer
)
returns void language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_old_game public.mlp_games%rowtype;
  v_stale_game public.mlp_games%rowtype;
  v_expected_type text;
  v_game_winner uuid;
  v_a4 integer;
  v_b4 integer;
  v_count4 integer;
  v_w1 integer;
  v_w2 integer;
  v_db_winner uuid;
  v_completed boolean := false;
  v_match_winner uuid;
  v_group_name text;
begin
  v_expected_type := case p_game_order
    when 1 then 'women_doubles' when 2 then 'men_doubles'
    when 3 then 'mixed_1' when 4 then 'mixed_2'
    when 5 then 'dreambreaker' else null end;
  if v_expected_type is null or p_game_type is distinct from v_expected_type then
    raise exception 'Invalid MLP game order or type';
  end if;
  if p_team1_score is null or p_team2_score is null or
     p_team1_score < 0 or p_team2_score < 0 or p_team1_score = p_team2_score then
    raise exception 'Invalid score';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id
  where s.id = p_session_token and s.active = true and s.expires_at > now()
    and c.active = true and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  if not exists (
    select 1 from public.tournaments t
    join public.mlp_configs c on c.tournament_id = t.id
    where t.id = v_match.tournament_id and t.format = 'mlp'
      and c.style = 'basic' and c.members_per_team <> 3
      and (select count(*) from public.mlp_slots x where x.tournament_id = t.id) <> 3
  ) then raise exception 'Game scoring is only allowed for MLP Basic'; end if;
  select count(*),
         count(*) filter (where winner_team_id = v_match.team1_id),
         count(*) filter (where winner_team_id = v_match.team2_id)
  into v_count4, v_a4, v_b4 from public.mlp_games
  where match_id = p_match_id and game_order between 1 and 4;
  if p_game_order = 5 and not (v_count4 = 4 and v_a4 = 2 and v_b4 = 2) then
    raise exception 'DreamBreaker requires a 2-2 tie after games 1-4';
  end if;
  select * into v_old_game from public.mlp_games
  where match_id = p_match_id and game_order = p_game_order;
  v_game_winner := case when p_team1_score > p_team2_score then v_match.team1_id
                        else v_match.team2_id end;
  if v_old_game.id is null then
    insert into public.mlp_games
      (match_id, game_order, game_type, team1_score, team2_score, winner_team_id)
    values (p_match_id, p_game_order, v_expected_type,
            p_team1_score, p_team2_score, v_game_winner);
  else
    update public.mlp_games set game_type = v_expected_type,
      team1_score = p_team1_score, team2_score = p_team2_score,
      winner_team_id = v_game_winner where id = v_old_game.id;
  end if;
  select count(*),
         count(*) filter (where winner_team_id = v_match.team1_id),
         count(*) filter (where winner_team_id = v_match.team2_id)
  into v_count4, v_a4, v_b4 from public.mlp_games
  where match_id = p_match_id and game_order between 1 and 4;
  if v_count4 <> 4 or v_a4 <> 2 or v_b4 <> 2 then
    select * into v_stale_game from public.mlp_games
    where match_id = p_match_id and game_order = 5;
    if v_stale_game.id is not null then
      delete from public.mlp_games where id = v_stale_game.id;
      insert into public.referee_score_logs
        (referee_session_id, tournament_id, group_id, group_name, match_id, match_code, referee_name,
         action, game_order, game_type, old_game_team1_score, old_game_team2_score)
      values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
              p_match_id, v_match.match_code,
              v_session.referee_name, 'mlp_game_invalidated', 5, 'dreambreaker',
              v_stale_game.team1_score, v_stale_game.team2_score);
    end if;
  end if;
  v_w1 := v_a4; v_w2 := v_b4;
  if v_count4 = 4 then
    if v_a4 <> v_b4 then
      v_completed := true;
      v_match_winner := case when v_a4 > v_b4 then v_match.team1_id else v_match.team2_id end;
    else
      select winner_team_id into v_db_winner from public.mlp_games
      where match_id = p_match_id and game_order = 5;
      if v_db_winner is not null then
        v_completed := true; v_match_winner := v_db_winner;
        v_w1 := v_a4 + case when v_db_winner = v_match.team1_id then 1 else 0 end;
        v_w2 := v_b4 + case when v_db_winner = v_match.team2_id then 1 else 0 end;
      end if;
    end if;
  end if;
  update public.matches set team1_score = v_w1, team2_score = v_w2,
    winner_id = case when v_completed then v_match_winner else null end,
    status = case when v_completed then 'completed' else 'scheduled' end,
    completed_at = case when v_completed then now() else null end
  where id = p_match_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code, referee_name,
     action, game_order, game_type, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score, old_game_team1_score,
     old_game_team2_score, new_game_team1_score, new_game_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          p_match_id, v_match.match_code,
          v_session.referee_name,
          case when v_old_game.id is null then 'submit_mlp_game' else 'edit_mlp_game' end,
          p_game_order, v_expected_type, v_match.team1_score, v_match.team2_score,
          v_w1, v_w2, v_old_game.team1_score, v_old_game.team2_score,
          p_team1_score, p_team2_score);
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
end;
$$;

revoke all on function public.get_referee_session(uuid) from public;
grant execute on function public.get_referee_session(uuid) to anon, authenticated;
-- Existing RPC grants are retained; direct anonymous table writes remain unavailable.
commit;
