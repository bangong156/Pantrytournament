create function pantry_knockout.enable_series_on_new_event(p_tournament uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 update public.tournament_events e set knockout_series=true
 from public.tournaments t
 where t.id=p_tournament and e.tournament_id=t.id and e.is_default
   and t.created_by=(select auth.uid()) and e.format='doubles'
   and pantry_access.can_operate_event(e.id)
   and not exists(select 1 from public.groups g where g.event_id=e.id)
   and not exists(select 1 from public.knockout_decisions d where d.event_id=e.id);
 if not found then raise exception 'Không thể bật Seri A/B cho nội dung này.' using errcode='42501'; end if;
end $$;
revoke all on function pantry_knockout.enable_series_on_new_event(uuid) from public;
grant execute on function pantry_knockout.enable_series_on_new_event(uuid) to authenticated;
create or replace function public.create_competition_with_series(p_name text,p_event_type text,p_start_date date,p_start_time time,p_format text,p_expected_team_count integer,p_style text,p_court_count integer)
returns uuid language plpgsql security invoker set search_path='' as $$
declare tid uuid;
begin
 if auth.uid() is null then raise exception 'Vui lòng đăng nhập.' using errcode='42501'; end if;
 if p_format is distinct from 'doubles' then raise exception 'Seri A/B chỉ hỗ trợ đánh đôi.'; end if;
 tid:=public.create_competition_with_courts(p_name,p_event_type,p_start_date,p_start_time,p_format,p_expected_team_count,p_style,p_court_count);
 perform pantry_knockout.enable_series_on_new_event(tid);
 return tid;
end $$;
