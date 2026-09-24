-- Run before deploying court-assignment UI. No RLS or scoring RPC changes.
begin;

alter table public.matches add column if not exists court_number integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.matches'::regclass
    and conname='matches_court_number_positive') then
    alter table public.matches add constraint matches_court_number_positive
      check (court_number is null or court_number > 0);
  end if;
end $$;

-- Courts are shared across events within a tournament. Future matches may queue
-- on the same court. This index also prevents races between simultaneous starts.
create unique index if not exists matches_playing_court_unique
  on public.matches(tournament_id,court_number)
  where status='playing' and court_number is not null;

create or replace function public._match_court_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare occupied text;
begin
  if new.status <> 'playing' or new.court_number is null then return new; end if;
  if tg_op='UPDATE' then
    if old.status = new.status and old.court_number is not distinct from new.court_number
      and old.tournament_id = new.tournament_id then return new; end if;
  end if;
  select m.match_code into occupied from public.matches m
    where m.tournament_id=new.tournament_id and m.court_number=new.court_number
      and m.status='playing' and m.id<>new.id limit 1;
  if found then
    raise exception 'Sân % đang có trận %.',new.court_number,coalesce(occupied,'đang đấu');
  end if;
  return new;
end $$;
revoke all on function public._match_court_guard() from public,anon,authenticated;
drop trigger if exists match_court_guard on public.matches;
create trigger match_court_guard before insert or update of status,court_number,tournament_id
  on public.matches for each row execute function public._match_court_guard();

-- Existing Admin/Staff RLS and event-header restrictions remain authoritative.
-- Only the new column is granted; no new public writes or table-wide grants.
grant select(court_number) on public.matches to anon,authenticated,service_role;
grant update(court_number) on public.matches to authenticated;
-- service_role uses a separate homepage metadata lookup; the video-create match
-- query remains id,event_id,tournament_id,match_code,team1_id,team2_id.
commit;
