CREATE OR REPLACE FUNCTION public._referee_match_controller(p_session_token uuid, p_match_id uuid, p_claim boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare assigned public.matches%rowtype; controller uuid;
begin
  select m.* into assigned from public.matches m
    join public.get_referee_session(p_session_token) s
      on s.tournament_id=m.tournament_id and s.group_id=m.group_id
    join public.referee_sessions session on session.id=s.session_token and session.event_id=m.event_id
    where m.id=p_match_id and m.stage='group' for update of m;
  if assigned.id is null then raise exception 'You do not have permission for this match' using errcode='42501'; end if;
  -- Historical corrections retain their existing authorization.
  if assigned.status='completed' then return; end if;
  if p_claim then
    insert into public.referee_match_controllers(match_id,referee_session_id)
      values(p_match_id,p_session_token) on conflict(match_id) do update
      set referee_session_id=excluded.referee_session_id, claimed_at=now()
      where assigned.status='scheduled';
  end if;
  select c.referee_session_id into controller from public.referee_match_controllers c where c.match_id=p_match_id;
  if controller is distinct from p_session_token then
    raise exception 'Trận này do trọng tài khác điều khiển. Hãy bắt đầu/tiếp tục trận chưa có trọng tài.' using errcode='42501';
  end if;
end $function$
;
