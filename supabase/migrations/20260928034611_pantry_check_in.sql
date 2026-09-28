-- Run manually after the existing multi-event and Guest Organizer migrations.
-- No RLS policies are replaced or broadened.
begin;
alter table public.teams
  add column if not exists checked_in boolean not null default false,
  add column if not exists checked_in_at timestamptz;

-- Replace membership atomically under the caller's existing RLS permissions.
-- Player IDs are resolved by the application's existing roster-player path.
create or replace function public.pantry_replace_team_members(
  p_event uuid, p_team uuid, p_members jsonb
) returns void language plpgsql security invoker set search_path='' as $$
declare
  v_team public.teams%rowtype;
  v_member jsonb;
  v_count integer;
  v_changed integer;
  v_name text;
  v_format text;
begin
  select * into v_team from public.teams where id=p_team and event_id=p_event for update;
  if not found then raise exception 'Không tìm thấy đội trong nội dung này'; end if;
  if auth.uid() is null or not coalesce(public.is_staff() or public.can_manage_tournament(auth.uid(),v_team.tournament_id),false)
    or not public._competition_write_scope(p_event) then
    raise exception 'Không có quyền vận hành' using errcode='42501';
  end if;
  if jsonb_typeof(p_members) is distinct from 'array' then raise exception 'Đội hình không hợp lệ'; end if;
  select count(*) into v_count from public.team_members where team_id=p_team and event_id=p_event;
  if v_count=0 or jsonb_array_length(p_members)<>v_count
    or (select count(distinct (x->>'slot_order')::integer) from jsonb_array_elements(p_members) x)<>v_count then
    raise exception 'Đội hình đã thay đổi; vui lòng tải lại';
  end if;
  for v_member in select value from jsonb_array_elements(p_members) loop
    update public.team_members set player_id=(v_member->>'player_id')::uuid
      where team_id=p_team and event_id=p_event and slot_order=(v_member->>'slot_order')::integer
      and player_id=(v_member->>'old_player_id')::uuid;
    get diagnostics v_changed=row_count;
    if v_changed<>1 then raise exception 'Đội hình đã thay đổi hoặc không có quyền sửa; vui lòng tải lại'; end if;
    if not exists(select 1 from public.players where id=(v_member->>'player_id')::uuid and length(btrim(full_name))>0) then
      raise exception 'VĐV không hợp lệ';
    end if;
  end loop;
  select format into v_format from public.tournament_events where id=p_event and tournament_id=v_team.tournament_id;
  if v_format is distinct from 'mlp' then
    select string_agg(p.full_name,' - ' order by tm.slot_order) into v_name
      from public.team_members tm join public.players p on p.id=tm.player_id
      where tm.team_id=p_team and tm.event_id=p_event;
    update public.teams set name=v_name where id=p_team and event_id=p_event;
    get diagnostics v_changed=row_count;
    if v_changed<>1 then raise exception 'Không có quyền sửa đội'; end if;
  end if;
end $$;
revoke all on function public.pantry_replace_team_members(uuid,uuid,jsonb) from public,anon;
grant execute on function public.pantry_replace_team_members(uuid,uuid,jsonb) to authenticated;
commit;
