-- Apply after pantry-live-scorekeeper.sql. Safe to rerun.
-- Match scores, referee authorization, and win-by-2 rules are unchanged.
begin;

alter table public.matches alter column score_target set default 11;
alter table public.matches drop constraint if exists matches_live_score_target_check;
alter table public.matches add constraint matches_live_score_target_check
  check (score_target between 1 and 999);

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
  if p_score_target is null or p_score_target < 1 or p_score_target > 999 or p_win_by_two is null then
    raise exception 'Đích điểm phải là số nguyên từ 1 đến 999.';
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


revoke all on function public.referee_live_start(uuid,uuid,integer,boolean) from public;
grant execute on function public.referee_live_start(uuid,uuid,integer,boolean) to anon, authenticated;
commit;
