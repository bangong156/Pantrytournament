-- Manual migration. Existing RLS and referee/scoring functions are unchanged.
begin;
alter table public.tournaments add column if not exists court_count integer not null default 6;
alter table public.tournaments add constraint tournaments_court_count_positive check (court_count>=1);
grant select(court_count) on public.tournaments to anon,authenticated,service_role;
grant insert(court_count),update(court_count) on public.tournaments to authenticated;

-- Preserve every legacy assigned/playing court during initial installation.
update public.tournaments t set court_count=m.maximum
from (select tournament_id,max(court_number) maximum from public.matches
      where status in ('scheduled','playing') group by tournament_id) m
where t.id=m.tournament_id and m.maximum>t.court_count;

-- Read all events for physical-court safety; does not grant any write access.
create function public._tournament_court_count_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare occupied integer;
begin
 if new.court_count<old.court_count then
  select court_number into occupied from public.matches
  where tournament_id=new.id and status='playing' and court_number>new.court_count
  order by court_number limit 1;
  if found then raise exception 'Không thể giảm số sân vì Sân % đang có trận thi đấu.',occupied; end if;
 end if;
 return new;
end $$;
revoke all on function public._tournament_court_count_guard() from public,anon,authenticated;
create trigger tournament_court_count_guard before update of court_count on public.tournaments
for each row execute function public._tournament_court_count_guard();

-- Serialize assignments/starts against count changes and concurrent calls.
create function public._match_operational_court_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare available integer; assigning boolean;
begin
 if new.status not in ('scheduled','playing') or new.court_number is null then return new; end if;
 if tg_op='UPDATE' then
  if new.court_number is not distinct from old.court_number and new.status=old.status
     and new.tournament_id=old.tournament_id then return new; end if;
 end if;
 select court_count into available from public.tournaments where id=new.tournament_id for update;
 if new.court_number<1 or new.court_number>available then
  raise exception 'Sân phải nằm trong khoảng 1 đến %.',available;
 end if;
 assigning:=new.status='scheduled';
 if assigning then
  if new.team1_id is null or new.team2_id is null or new.team1_id=new.team2_id then
   raise exception 'Trận chưa đủ hai đội để gọi.';
  end if;
  if exists(select 1 from public.matches where tournament_id=new.tournament_id and id<>new.id
    and court_number=new.court_number and status in ('playing','scheduled')) then
   raise exception 'Sân % đang có trận thi đấu hoặc đang gọi.',new.court_number;
  end if;
  if exists(select 1 from public.matches where tournament_id=new.tournament_id and id<>new.id
    and (status='playing' or (status='scheduled' and court_number between 1 and available))
    and (team1_id in(new.team1_id,new.team2_id) or team2_id in(new.team1_id,new.team2_id))) then
   raise exception 'Đội đang thi đấu hoặc đã được gọi vào sân khác.';
  end if;
  if new.stage='group' and (select count(*) from public.teams
    where id in(new.team1_id,new.team2_id) and event_id=new.event_id and checked_in)<>2 then
   raise exception 'Hai đội chưa đủ CHECK-IN.';
  end if;
 end if;
 return new;
end $$;
revoke all on function public._match_operational_court_guard() from public,anon,authenticated;
create trigger match_operational_court_guard before insert or update of court_number,status,tournament_id on public.matches
for each row execute function public._match_operational_court_guard();

-- Compose the existing creation flow, atomically, without rewriting its rules.
create function public.create_competition_with_courts(
 p_name text,p_event_type text,p_start_date date,p_start_time time,p_format text,
 p_expected_team_count integer,p_style text,p_court_count integer
) returns uuid language plpgsql security invoker set search_path='' as $$
declare tid uuid; changed integer;
begin
 if p_court_count is null or p_court_count<1 then raise exception 'Số sân phải là số nguyên từ 1 trở lên.'; end if;
 tid:=public.create_competition_tournament(p_name,p_event_type,p_start_date,p_start_time,p_format,p_expected_team_count,p_style);
 update public.tournaments set court_count=p_court_count where id=tid;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'Không có quyền lưu số sân.' using errcode='42501'; end if;
 return tid;
end $$;
revoke all on function public.create_competition_with_courts(text,text,date,time,text,integer,text,integer) from public,anon;
grant execute on function public.create_competition_with_courts(text,text,date,time,text,integer,text,integer) to authenticated;
commit;
