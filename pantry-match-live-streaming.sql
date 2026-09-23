-- Phase 1 match video, MANUAL migration. Do not rerun the Multi-event migration.
-- No existing tournament, event, match, referee or score rows are modified.
begin;
create table public.match_video_sessions (
  id uuid primary key,
  match_id uuid not null,
  event_id uuid not null,
  tournament_id uuid not null,
  created_by uuid not null,
  status text not null check(status in ('creating','ready','publishing','connecting','live','stopping','ended')),
  version integer not null default 0,
  invite_hash text not null check(length(invite_hash)=64),
  invite_expires_at timestamptz not null,
  lease_hash text,
  lease_expires_at timestamptz,
  hard_expires_at timestamptz not null,
  last_media_at timestamptz,
  media_bytes bigint not null default 0,
  input_uid text,
  credentials_ciphertext text,
  playback_url text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  cleanup_after timestamptz not null default now()
);
-- Soft references deliberately retain provider cleanup state if a match/event is
-- removed by existing regroup/delete workflows. The server validates current
-- match ownership on creation, publishing, heartbeat and all public reads.
-- No new cascading FK or trigger touches existing competition functionality.
create unique index match_video_one_active_match
  on public.match_video_sessions(match_id) where status<>'ended';
create index match_video_event_active on public.match_video_sessions(event_id,status);
create index match_video_cleanup on public.match_video_sessions(cleanup_after) where status<>'ended';
alter table public.match_video_sessions enable row level security;
revoke all on public.match_video_sessions from public,anon,authenticated;
grant select,insert,update,delete on public.match_video_sessions to service_role;

create table public.match_video_rate_limits (
  key_hash text primary key,
  window_start timestamptz not null,
  hits integer not null
);
alter table public.match_video_rate_limits enable row level security;
revoke all on public.match_video_rate_limits from public,anon,authenticated;
grant select,insert,update,delete on public.match_video_rate_limits to service_role;
create function public.match_video_take_rate(p_key text,p_limit integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  if length(p_key)<>64 or p_limit<1 or p_limit>120 then
    raise exception 'Invalid video rate limit';
  end if;
  insert into public.match_video_rate_limits(key_hash,window_start,hits)
    values(p_key,clock_timestamp(),1)
  on conflict(key_hash) do update set
    hits=case when match_video_rate_limits.window_start<clock_timestamp()-interval '1 minute'
      then 1 else least(match_video_rate_limits.hits+1,121) end,
    window_start=case when match_video_rate_limits.window_start<clock_timestamp()-interval '1 minute'
      then clock_timestamp() else match_video_rate_limits.window_start end
  returning hits into n;
  return n<=p_limit;
end $$;
revoke all on function public.match_video_take_rate(text,integer) from public,anon,authenticated;
grant execute on function public.match_video_take_rate(text,integer) to service_role;
notify pgrst,'reload schema';
commit;
