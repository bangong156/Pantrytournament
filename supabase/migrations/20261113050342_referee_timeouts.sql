create table public.referee_timeouts (
 match_id uuid not null references public.matches(id) on delete cascade,
 team integer not null check (team in (1,2)),
 started_at timestamptz not null default clock_timestamp(),
 primary key (match_id,team)
);
alter table public.referee_timeouts enable row level security;
revoke all on public.referee_timeouts from anon,authenticated;

-- Referee sessions already validate assignment, expiry and current match control.
create function public.referee_match_timeouts(p_session_token uuid,p_match_id uuid,p_team integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare snapshot jsonb; result jsonb;
begin
 perform 1 from public.matches where id=p_match_id and stage='group' for update;
 if not found then raise exception 'Không tìm thấy trận vòng bảng'; end if;
 snapshot:=public.referee_match_state(p_session_token,p_match_id);
 if snapshot is null or (snapshot->>'match_id')::uuid is distinct from p_match_id then
  raise exception 'Phiên trọng tài không hợp lệ' using errcode='42501';
 end if;
 if p_team is not null then
  if p_team not in (1,2) then raise exception 'Đội không hợp lệ'; end if;
  if (snapshot->>'can_control')::boolean is distinct from true or snapshot->>'status' is distinct from 'playing' then
   raise exception 'Chỉ trọng tài đang điều khiển trận được gọi Time out' using errcode='42501';
  end if;
  insert into public.referee_timeouts(match_id,team) values(p_match_id,p_team)
   on conflict (match_id,team) do nothing;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('team',team,'expires_at',started_at+interval '59 seconds') order by team),'[]'::jsonb)
  into result from public.referee_timeouts where match_id=p_match_id;
 return jsonb_build_object('timeouts',result,'server_now',clock_timestamp());
end $$;
revoke all on function public.referee_match_timeouts(uuid,uuid,integer) from public;
grant execute on function public.referee_match_timeouts(uuid,uuid,integer) to anon,authenticated;
