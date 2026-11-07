CREATE OR REPLACE FUNCTION public.pantry_knockout_referee_score(p_code text, p_event uuid, p_match uuid, p_expected_revision bigint, p_expected_score_version bigint, p_score1 integer, p_score2 integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.matches%rowtype; d public.knockout_decisions%rowtype; winner uuid;
begin
  if p_code is distinct from '7777' then raise exception 'Mã trọng tài không đúng' using errcode='42501'; end if;
  perform pantry_knockout.lock_event(p_event);
  perform pantry_knockout.require_supported_scoring(p_event);
  select * into d from public.knockout_decisions where event_id=p_event for update;
  if d.state is distinct from 'generated' or d.revision is distinct from p_expected_revision then raise exception 'Stale managed bracket revision' using errcode='PT409'; end if;
  select * into m from public.matches where id=p_match and event_id=p_event and id=any(d.match_ids) for update;
  if not found or m.stage='group' then raise exception 'Match is outside this managed event'; end if;
  if m.score_version is distinct from p_expected_score_version then raise exception 'Score changed; reload' using errcode='PT409'; end if;
  if m.team1_id is null or m.team2_id is null then raise exception 'Participants unresolved'; end if;
  if p_score1 is null or p_score2 is null or p_score1<0 or p_score2<0 or p_score1=p_score2 then raise exception 'Enter two nonnegative unequal scores'; end if;
  winner:=case when p_score1>p_score2 then m.team1_id else m.team2_id end;
  -- guard_match rejects a changed winner if ANY downstream node has started.
  -- The exception rolls back parent score and all participant updates together.
  update public.matches set team1_score=p_score1,team2_score=p_score2,winner_id=winner,
    status='completed',completed_at=clock_timestamp(),score_version=score_version+1 where id=p_match and event_id=p_event;
  update public.matches set
    team1_id=case when team1_source_match_id=p_match then winner else team1_id end,
    team2_id=case when team2_source_match_id=p_match then winner else team2_id end
    where event_id=p_event and (team1_source_match_id=p_match or team2_source_match_id=p_match)
      and (case when team1_source_match_id=p_match then team1_id else team2_id end) is distinct from winner;
  set constraints all immediate;
end $function$
;
revoke all on function public.pantry_knockout_referee_score(text,uuid,uuid,bigint,bigint,integer,integer) from public;
grant execute on function public.pantry_knockout_referee_score(text,uuid,uuid,bigint,bigint,integer,integer) to anon,authenticated;
create or replace function public.pantry_knockout_referee_state(p_code text,p_event uuid,p_match uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
if p_code is distinct from '7777' then raise exception 'Mã trọng tài không đúng' using errcode='42501'; end if;
select jsonb_build_object('match',to_jsonb(m),'revision',d.revision) into result from public.matches m join public.knockout_decisions d on d.event_id=m.event_id where m.id=p_match and m.event_id=p_event and m.stage<>'group' and d.state='generated' and m.id=any(d.match_ids);
if result is null then raise exception 'Trận knockout không hợp lệ'; end if;
return result;
end $$;
revoke all on function public.pantry_knockout_referee_state(text,uuid,uuid) from public;
grant execute on function public.pantry_knockout_referee_state(text,uuid,uuid) to anon,authenticated;