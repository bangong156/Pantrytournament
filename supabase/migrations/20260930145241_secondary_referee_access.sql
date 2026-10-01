-- MANUAL ONLY: apply after Pantry multi-event + hardened/readable referee codes.
-- Playing capacity only: secondary OFF = 1, ON = 2 different group matches.
-- Reuses the existing start lock; no exclusive controller/session ownership.
-- Score calculations, score writes/conflict checks, streaming and policies stay unchanged.
begin;

alter table public.referee_access_codes
  add column secondary_code text check (secondary_code ~ '^[0-9]{5}$'),
  add column secondary_code_hash text,
  add column secondary_enabled boolean not null default false,
  add column secondary_failed_attempts integer not null default 0,
  add column secondary_locked_until timestamptz,
  add constraint secondary_referee_enabled_code_check
    check (not secondary_enabled or (secondary_code is not null and secondary_code_hash is not null));

-- One assignment row per group already exists. A tournament-wide unique code
-- resolves exactly one group even when the caller is viewing another event.
create unique index referee_secondary_code_tournament_idx
  on public.referee_access_codes(tournament_id, secondary_code)
  where secondary_code is not null;

alter table public.referee_sessions
  add column is_secondary boolean not null default false;

-- Replace the fixed unique index with the same group lock plus a counted
-- limit. The trigger retains database enforcement for ALL existing write paths.
drop index public.matches_one_live_per_group_idx;
create index matches_playing_per_group_idx
  on public.matches(tournament_id,event_id,group_id)
  where status='playing' and stage='group';

create function public._referee_group_playing_capacity()
returns trigger language plpgsql security definer set search_path='' as $$
declare max_playing integer;
begin
  if new.status is distinct from 'playing' or new.stage is distinct from 'group'
    or new.group_id is null then return new; end if;
  if tg_op='UPDATE' then
    if old.status='playing' and old.stage='group'
      and old.tournament_id=new.tournament_id and old.event_id=new.event_id
      and old.group_id=new.group_id then return new; end if;
  end if;
  -- Same transaction lock/key already used by referee_live_start.
  perform pg_advisory_xact_lock(hashtextextended(new.group_id::text,71513));
  select case when c.secondary_enabled then 2 else 1 end into max_playing
    from public.referee_access_codes c where c.tournament_id=new.tournament_id
      and c.event_id=new.event_id and c.group_id=new.group_id;
  if (select count(*) from public.matches m where m.tournament_id=new.tournament_id
    and m.event_id=new.event_id and m.group_id=new.group_id
    and m.status='playing' and m.stage='group' and m.id<>new.id)>=coalesce(max_playing,1) then
    raise exception 'Bảng đã đạt giới hạn % trận đang đánh.',coalesce(max_playing,1);
  end if;
  return new;
end $$;
revoke all on function public._referee_group_playing_capacity() from public,anon,authenticated;
create trigger referee_group_playing_capacity
  before insert or update of status,stage,tournament_id,event_id,group_id on public.matches
  for each row execute function public._referee_group_playing_capacity();

-- Change only the existing start guard, preserving the installed authorization,
-- target/win-by-two handling, court safeguards, score writes and audit behavior.
do $capacity$
declare definition text; previous_guard text; revised_guard text;
begin
  definition:=pg_get_functiondef('public.referee_live_start(uuid,uuid,integer,boolean)'::regprocedure);
  previous_guard:=$guard$  if exists (select 1 from public.matches m
             where m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id and m.group_id = v_session.group_id
               and m.stage = 'group' and m.status = 'playing' and m.id <> p_match_id) then
    raise exception 'Finish the active match before starting another';
  end if;$guard$;
  revised_guard:=$guard$  if (select count(*) from public.matches m
      where m.tournament_id=v_session.tournament_id and m.event_id=v_session.event_id
        and m.group_id=v_session.group_id and m.stage='group'
        and m.status='playing' and m.id<>p_match_id)>=coalesce((
      select case when c.secondary_enabled then 2 else 1 end
        from public.referee_access_codes c where c.id=v_session.access_code_id),1) then
    raise exception 'Bảng đã đạt giới hạn trận đang đánh.';
  end if;$guard$;
  if position(previous_guard in definition)=0
    or position('pg_advisory_xact_lock(hashtextextended(v_session.group_id::text, 71513))' in definition)=0 then
    raise exception 'Unrecognized group start guard/lock; review before applying';
  end if;
  execute replace(definition,previous_guard,revised_guard);
end $capacity$;

-- The legacy group-state RPC still works. This reader lets the existing scoring
-- screen refresh its selected match when there are two, without session redesign.
create function public.referee_match_state(p_session_token uuid,p_match_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare allowed_match uuid;
begin
  if not exists(select 1 from public.get_referee_session(p_session_token)) then
    raise exception 'Referee access expired or revoked';
  end if;
  select m.id into allowed_match from public.get_referee_session(p_session_token) valid
    join public.referee_sessions s on s.id=valid.session_token
    join public.matches m on m.tournament_id=s.tournament_id and m.event_id=s.event_id and m.group_id=s.group_id
    where m.id=p_match_id and m.stage='group' and m.status='playing'
      and public._referee_event_live_allowed(m.event_id);
  if allowed_match is null then return null; end if;
  return public._referee_live_snapshot(allowed_match);
end $$;
revoke all on function public.referee_match_state(uuid,uuid) from public;
grant execute on function public.referee_match_state(uuid,uuid) to anon,authenticated;

-- Fail closed if legacy table-wide SELECT would expose newly added secrets.
-- Hardened installations already use column-only grants on this table.
do $$
begin
  if has_table_privilege('anon', 'public.referee_access_codes', 'SELECT')
    or has_table_privilege('authenticated', 'public.referee_access_codes', 'SELECT') then
    raise exception 'Apply hardened/readable referee-code grants before this migration';
  end if;
end $$;
revoke select (secondary_code, secondary_code_hash, secondary_enabled,
  secondary_failed_attempts, secondary_locked_until)
  on public.referee_access_codes from public, anon, authenticated;

-- Change only the NEW-code validation in the installed setter, preserving any
-- existing staff/ownership checks, event handling, hashing and session revocation.
-- The primary claim RPC is untouched: existing 6-digit (and other legacy) hashes
-- remain valid. No existing assignment or code is rotated by this migration.
do $migration$
declare definition text; revised text;
begin
  definition := pg_get_functiondef('public.set_referee_code(uuid,uuid,text,timestamptz)'::regprocedure);
  revised := regexp_replace(definition,
    'length\(trim\(p_code\)\) < [0-9]+',
    'trim(p_code) !~ ''^[0-9]{4}$''');
  if revised = definition then
    raise exception 'Unrecognized primary-code setter validation; review before applying';
  end if;
  revised := regexp_replace(revised,
    'Referee code must contain at least [0-9]+ characters',
    'New primary referee code must contain exactly 4 numeric digits');
  execute revised;
end $migration$;

-- Authorization for code management only. Anonymous primary referees prove
-- possession of a valid existing session; secondary sessions cannot manage codes.
create function public._secondary_referee_authorize(
  p_tournament_id uuid, p_group_id uuid, p_session_token uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare eid uuid;
begin
  select g.event_id into eid from public.groups g
    where g.id=p_group_id and g.tournament_id=p_tournament_id;
  if eid is null then raise exception 'Group does not belong to this tournament'; end if;
  if p_session_token is not null then
    if not exists (
      select 1 from public.get_referee_session(p_session_token) valid
      join public.referee_sessions s on s.id=valid.session_token
      where valid.tournament_id=p_tournament_id and valid.group_id=p_group_id
        and s.event_id=eid and not s.is_secondary
    ) then raise exception 'Primary referee permission required' using errcode='42501'; end if;
  elsif auth.uid() is null or not exists (
    select 1 from public.profiles p where p.id=auth.uid() and lower(p.role::text)='admin'
  ) then raise exception 'Admin permission required' using errcode='42501';
  end if;
  return eid;
end $$;
revoke all on function public._secondary_referee_authorize(uuid,uuid,uuid) from public,anon,authenticated;

create function public.referee_secondary_context(p_session_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object('group_id',s.group_id,'is_secondary',s.is_secondary,
    'max_playing',case when c.secondary_enabled then 2 else 1 end,
    'enabled',case when s.is_secondary then false else c.secondary_enabled end,
    'code',case when not s.is_secondary and c.secondary_enabled then c.secondary_code else null end)
  into result
  from public.get_referee_session(p_session_token) valid
  join public.referee_sessions s on s.id=valid.session_token
  join public.referee_access_codes c on c.id=s.access_code_id
    and c.tournament_id=s.tournament_id and c.event_id=s.event_id and c.group_id=s.group_id;
  if result is null then raise exception 'Referee access expired or revoked'; end if;
  return result;
end $$;
revoke all on function public.referee_secondary_context(uuid) from public;
grant execute on function public.referee_secondary_context(uuid) to anon,authenticated;

create function public.admin_event_secondary_referee_codes(p_event_id uuid)
returns table(group_id uuid,enabled boolean,code text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p where p.id=auth.uid() and lower(p.role::text)='admin'
  ) then raise exception 'Admin permission required' using errcode='42501'; end if;
  return query select c.group_id,c.secondary_enabled,
    case when c.secondary_enabled then c.secondary_code else null end
  from public.referee_access_codes c
  join public.groups g on g.id=c.group_id and g.tournament_id=c.tournament_id and g.event_id=c.event_id
  where c.event_id=p_event_id and c.active and (c.expires_at is null or c.expires_at>now());
end $$;
revoke all on function public.admin_event_secondary_referee_codes(uuid) from public,anon;
grant execute on function public.admin_event_secondary_referee_codes(uuid) to authenticated;

create function public.manage_secondary_referee_code(
  p_tournament_id uuid, p_group_id uuid, p_action text, p_session_token uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare eid uuid; assignment public.referee_access_codes%rowtype;
  candidate text; random_bytes bytea; random_value integer; attempts integer:=0;
begin
  eid := public._secondary_referee_authorize(p_tournament_id,p_group_id,p_session_token);
  if p_action is null or p_action not in ('activate','regenerate','disable') then
    raise exception 'Invalid secondary referee action';
  end if;
  -- Serialize code generation and claims across this tournament. The 5-digit
  -- namespace is tournament-scoped, independent of the existing LIVE locks.
  perform pg_advisory_xact_lock(hashtextextended(p_tournament_id::text,73521));
  -- Serialize enabled-state changes with starts using the existing group lock.
  perform pg_advisory_xact_lock(hashtextextended(p_group_id::text,71513));
  select c.* into assignment from public.referee_access_codes c
    where c.tournament_id=p_tournament_id and c.group_id=p_group_id and c.event_id=eid
    for update;
  -- Recheck session validity after acquiring the lock (primary may be revoked).
  perform public._secondary_referee_authorize(p_tournament_id,p_group_id,p_session_token);
  if assignment.id is null or not assignment.active
    or assignment.expires_at <= now() then raise exception 'An active primary referee code is required'; end if;
  if p_action='disable' then
    -- Never stop/delete a match to reduce the limit. Finish one before switching OFF.
    if (select count(*) from public.matches m where m.tournament_id=p_tournament_id
      and m.event_id=eid and m.group_id=p_group_id and m.stage='group' and m.status='playing')>1 then
      raise exception 'Hãy kết thúc một trận trước khi tắt trọng tài phụ.';
    end if;
    update public.referee_access_codes set secondary_enabled=false where id=assignment.id;
    return jsonb_build_object('enabled',false,'code',null);
  end if;
  if p_action='activate' and assignment.secondary_enabled then
    return jsonb_build_object('enabled',true,'code',assignment.secondary_code);
  end if;
  loop
    attempts := attempts+1;
    if attempts>1000 then raise exception 'Could not allocate a distinct secondary code'; end if;
    random_bytes := extensions.gen_random_bytes(3);
    random_value := get_byte(random_bytes,0)*65536+get_byte(random_bytes,1)*256+get_byte(random_bytes,2);
    -- Rejection sampling gives an unbiased cryptographically random 10000..99999.
    if random_value>=16740000 then continue; end if;
    candidate := (10000+random_value%90000)::text;
    if candidate=assignment.secondary_code then continue; end if;
    if extensions.crypt(candidate,assignment.code_hash)=assignment.code_hash then continue; end if;
    if not exists(select 1 from public.referee_access_codes c
      where c.tournament_id=p_tournament_id and c.secondary_code=candidate) then exit; end if;
  end loop;
  update public.referee_access_codes set secondary_code=candidate,
    secondary_code_hash=extensions.crypt(candidate,extensions.gen_salt('bf')),
    secondary_enabled=true,secondary_failed_attempts=0,secondary_locked_until=null
    where id=assignment.id;
  -- Existing sessions are deliberately retained. Old codes cannot create NEW
  -- sessions; disabling/regeneration never changes primary sessions or scores.
  return jsonb_build_object('enabled',true,'code',candidate);
end $$;
revoke all on function public.manage_secondary_referee_code(uuid,uuid,text,uuid) from public;
grant execute on function public.manage_secondary_referee_code(uuid,uuid,text,uuid) to anon,authenticated;

create function public.claim_secondary_referee_access(p_tournament_id uuid,p_code text)
returns table(session_token uuid,tournament_id uuid,group_id uuid,
  group_name text,referee_name text,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare assignment public.referee_access_codes%rowtype;
  claimed public.referee_sessions%rowtype; group_label text;
begin
  if p_code is null or trim(p_code) !~ '^[0-9]{5}$' then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tournament_id::text,73521));
  -- Limit tournament-wide code guessing separately from PRIMARY-code counters.
  -- No anonymous code/group enumeration is exposed. A bad guess records a failure
  -- for enabled secondary assignments only; primary access is never locked.
  if exists(select 1 from public.referee_access_codes c where c.tournament_id=p_tournament_id
    and c.secondary_enabled and c.active and (c.expires_at is null or c.expires_at>now())
    and c.secondary_locked_until>now()) then return; end if;
  select c.* into assignment from public.referee_access_codes c
    join public.groups g on g.id=c.group_id and g.tournament_id=c.tournament_id and g.event_id=c.event_id
    where c.tournament_id=p_tournament_id and c.secondary_enabled and c.active
      and (c.expires_at is null or c.expires_at>now()) and c.secondary_code=trim(p_code)
    for update of c;
  if assignment.id is null or
    extensions.crypt(trim(p_code),assignment.secondary_code_hash)<>assignment.secondary_code_hash then
    update public.referee_access_codes c set
      secondary_failed_attempts=case when c.secondary_locked_until<=now() then 1 else c.secondary_failed_attempts+1 end,
      secondary_locked_until=case when (case when c.secondary_locked_until<=now() then 1 else c.secondary_failed_attempts+1 end)>=10
        then now()+interval '5 minutes' else null end
    where c.tournament_id=p_tournament_id and c.secondary_enabled and c.active
      and (c.expires_at is null or c.expires_at>now());
    return;
  end if;
  select g.name into group_label from public.groups g
    where g.id=assignment.group_id and g.tournament_id=assignment.tournament_id and g.event_id=assignment.event_id;
  update public.referee_access_codes set secondary_failed_attempts=0,secondary_locked_until=null
    where id=assignment.id;
  insert into public.referee_sessions(access_code_id,tournament_id,event_id,group_id,referee_name,is_secondary)
    values(assignment.id,assignment.tournament_id,assignment.event_id,assignment.group_id,'Trọng tài phụ',true)
    returning * into claimed;
  return query select claimed.id,claimed.tournament_id,claimed.group_id,
    group_label,claimed.referee_name,claimed.expires_at;
end $$;
revoke all on function public.claim_secondary_referee_access(uuid,text) from public;
grant execute on function public.claim_secondary_referee_access(uuid,text) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
