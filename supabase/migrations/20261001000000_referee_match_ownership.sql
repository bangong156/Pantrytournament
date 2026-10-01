-- MANUAL ONLY. Apply after 20260930145241_secondary_referee_access.sql.
-- Keep controller session tokens out of publicly readable matches/snapshots.
begin;
create table public.referee_match_controllers (
  match_id uuid primary key references public.matches(id) on delete cascade,
  referee_session_id uuid not null references public.referee_sessions(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
create index referee_match_controllers_session_idx on public.referee_match_controllers(referee_session_id);
alter table public.referee_match_controllers enable row level security;
revoke all on public.referee_match_controllers from public,anon,authenticated;

create function public._referee_match_controller(p_session_token uuid,p_match_id uuid,p_claim boolean default false)
returns void language plpgsql security definer set search_path='' as $$
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
      values(p_match_id,p_session_token) on conflict(match_id) do nothing;
  end if;
  select c.referee_session_id into controller from public.referee_match_controllers c where c.match_id=p_match_id;
  if controller is distinct from p_session_token then
    raise exception 'Trận này do trọng tài khác điều khiển. Hãy bắt đầu/tiếp tục trận chưa có trọng tài.' using errcode='42501';
  end if;
end $$;
revoke all on function public._referee_match_controller(uuid,uuid,boolean) from public,anon,authenticated;

-- Explicit continuation for legacy active matches, including MLP game screens.
-- Read RPCs never call this function or claim ownership.
create function public.referee_continue_match(p_session_token uuid,p_match_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.matches m
    join public.get_referee_session(p_session_token) valid
      on valid.tournament_id=m.tournament_id and valid.group_id=m.group_id
    join public.referee_sessions session on session.id=valid.session_token and session.event_id=m.event_id
    where m.id=p_match_id and m.stage='group' and m.status='playing' for update of m;
  if not found then raise exception 'No active match assigned to this referee' using errcode='42501'; end if;
  perform public._referee_match_controller(p_session_token,p_match_id,true);
end $$;
revoke all on function public.referee_continue_match(uuid,uuid) from public;
grant execute on function public.referee_continue_match(uuid,uuid) to anon,authenticated;

-- Safe metadata only: never return another referee's session token.
create function public.referee_match_ownership(p_session_token uuid)
returns table(match_id uuid,controller_name text,can_control boolean,is_claimed boolean)
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.get_referee_session(p_session_token)) then
    raise exception 'Referee access expired or revoked';
  end if;
  return query select m.id,s.referee_name,coalesce(c.referee_session_id=p_session_token,false),c.match_id is not null
    from public.get_referee_session(p_session_token) valid
    join public.referee_sessions session on session.id=valid.session_token
    join public.matches m on m.tournament_id=session.tournament_id and m.event_id=session.event_id
      and m.group_id=session.group_id and m.stage='group'
    left join public.referee_match_controllers c on c.match_id=m.id
    left join public.referee_sessions s on s.id=c.referee_session_id;
end $$;
revoke all on function public.referee_match_ownership(uuid) from public;
grant execute on function public.referee_match_ownership(uuid) to anon,authenticated;

create function public._referee_controller_snapshot(p_match_id uuid,p_session_token uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select public._referee_live_snapshot(p_match_id) || jsonb_build_object(
    'controller_name',o.controller_name,'can_control',o.can_control,'is_claimed',o.is_claimed)
  from public.referee_match_ownership(p_session_token) o where o.match_id=p_match_id;
$$;
revoke all on function public._referee_controller_snapshot(uuid,uuid) from public,anon,authenticated;

-- Keep installed implementations intact as private helpers. Catalog checks only;
-- no function-body text is inspected or rewritten.
do $ownership$
declare contract record; installed record; helper text; arguments text;
  invocation text; body text; guard text;
begin
  for contract in select * from (values
    ('referee_live_start','uuid,uuid,integer,boolean',array['p_session_token','p_match_id','p_score_target','p_win_by_two'],'jsonb','start'),
    ('referee_live_adjust','uuid,uuid,integer,integer,bigint,integer,integer,uuid',array['p_session_token','p_match_id','p_team','p_delta','p_expected_version','p_expected_team1_score','p_expected_team2_score','p_action_id'],'jsonb','write'),
    ('referee_live_finish','uuid,uuid,bigint,integer,integer',array['p_session_token','p_match_id','p_expected_version','p_expected_team1_score','p_expected_team2_score'],'jsonb','write'),
    ('referee_submit_score','uuid,uuid,integer,integer',array['p_session_token','p_match_id','p_team1_score','p_team2_score'],'void','write'),
    ('referee_submit_mlp_game','uuid,uuid,integer,text,integer,integer',array['p_session_token','p_match_id','p_game_order','p_game_type','p_team1_score','p_team2_score'],'void','write'),
    ('referee_live_state','uuid',array['p_session_token'],'jsonb','read'),
    ('referee_match_state','uuid,uuid',array['p_session_token','p_match_id'],'jsonb','read')
  ) as contracts(name,types,names,result,operation) loop
    select p.* into installed from pg_catalog.pg_proc p
      where p.oid=to_regprocedure(format('public.%I(%s)',contract.name,contract.types));
    if installed.oid is null or not installed.prosecdef or installed.proretset
      or installed.prokind <> 'f' or installed.prorettype <> to_regtype(contract.result)
      or installed.proargnames is distinct from contract.names or installed.proargmodes is not null then
      raise exception 'Unrecognized referee RPC contract: %',contract.name;
    end if;
    helper:='_ownership_original_'||contract.name;
    if to_regprocedure(format('public.%I(%s)',helper,contract.types)) is not null then
      raise exception 'Ownership helper already exists: %; review migration state',helper;
    end if;
    arguments:=pg_catalog.pg_get_function_arguments(installed.oid);
    select string_agg(format('%I',n),',' order by ordinal) into invocation
      from unnest(contract.names) with ordinality as names(n,ordinal);
    execute format('alter function public.%I(%s) rename to %I',contract.name,contract.types,helper);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated',helper,contract.types);
    guard:='';
    if contract.operation <> 'read' then
      if contract.operation='start' then
        -- Same lock key/order as the installed START: group lock before row lock.
        guard:=$guard$
          select valid.group_id into assigned_group from public.get_referee_session(p_session_token) valid;
          if assigned_group is null then raise exception 'Referee access expired or revoked'; end if;
          perform pg_advisory_xact_lock(hashtextextended(assigned_group::text,71513));
        $guard$;
      end if;
      guard:=guard||$guard$
        select m.status into match_status from public.matches m
          join public.get_referee_session(p_session_token) valid
            on valid.tournament_id=m.tournament_id and valid.group_id=m.group_id
          join public.referee_sessions session on session.id=valid.session_token and session.event_id=m.event_id
          where m.id=p_match_id and m.stage='group' for update of m;
        if not found then raise exception 'You do not have permission for this match' using errcode='42501'; end if;
      $guard$;
      if contract.operation='start' then
        guard:=guard||$guard$
          -- START claims scheduled matches; CONTINUE claims unowned playing matches.
          perform public._referee_match_controller(p_session_token,p_match_id,match_status='scheduled');
        $guard$;
      else
        guard:=guard||$guard$
          if match_status <> 'completed' and (match_status='playing' or
            exists(select 1 from public.referee_match_controllers c where c.match_id=p_match_id)) then
            perform public._referee_match_controller(p_session_token,p_match_id,false);
          end if;
        $guard$;
      end if;
    end if;
    if contract.result='void' then
      body:=format('declare match_status text; assigned_group uuid; begin %s perform public.%I(%s); end',guard,helper,invocation);
    else
      -- Append metadata to the original response, preserving stale/conflict flags.
      body:=format($body$
        declare match_status text; assigned_group uuid; snapshot jsonb; ownership jsonb;
        begin
          %s
          snapshot:=public.%I(%s);
          if snapshot is null then return null; end if;
          select jsonb_build_object('controller_name',o.controller_name,
            'can_control',o.can_control,'is_claimed',o.is_claimed) into ownership
            from public.referee_match_ownership(p_session_token) o
            where o.match_id=(snapshot->>'match_id')::uuid;
          return snapshot || coalesce(ownership,'{}'::jsonb);
        end
      $body$,guard,helper,invocation);
    end if;
    execute format('create function public.%I(%s) returns %s language plpgsql %s security definer set search_path='''' as %L',
      contract.name,arguments,contract.result,case when contract.operation='read' then 'stable' else 'volatile' end,body);
    execute format('revoke all on function public.%I(%s) from public',contract.name,contract.types);
    execute format('grant execute on function public.%I(%s) to anon,authenticated',contract.name,contract.types);
  end loop;
end $ownership$;

-- Required name without rewriting the installed authentication function's text.
-- Validate its catalog contract, then preserve the complete working code/claim
-- implementation as a private helper. No formatting/casing/default-name assumptions.
do $name$
declare installed record;
begin
  select p.* into installed from pg_catalog.pg_proc p
    where p.oid=to_regprocedure('public.claim_secondary_referee_access(uuid,text)');
  if installed.oid is null or installed.prokind <> 'f'
    or not installed.prosecdef or not installed.proretset
    or installed.prorettype <> 'record'::regtype
    or installed.proargnames is distinct from array[
      'p_tournament_id','p_code','session_token','tournament_id','group_id',
      'group_name','referee_name','expires_at']::text[]
    or installed.proallargtypes is distinct from array[
      'uuid'::regtype::oid,'text'::regtype::oid,
      'uuid'::regtype::oid,'uuid'::regtype::oid,'uuid'::regtype::oid,
      'text'::regtype::oid,'text'::regtype::oid,'timestamptz'::regtype::oid]
    or installed.proargmodes is distinct from array['i','i','t','t','t','t','t','t']::"char"[] then
    raise exception 'Unrecognized secondary referee login contract; review before applying';
  end if;
  if to_regprocedure('public.claim_secondary_referee_access(uuid,text,text)') is not null then
    raise exception 'Named secondary referee RPC already exists; review migration state';
  end if;
  if to_regprocedure('public._claim_secondary_referee_access(uuid,text)') is not null then
    raise exception 'Private secondary referee login helper already exists; review migration state';
  end if;
end $name$;
alter function public.claim_secondary_referee_access(uuid,text)
  rename to _claim_secondary_referee_access;
revoke all on function public._claim_secondary_referee_access(uuid,text) from public,anon,authenticated;

create function public.claim_secondary_referee_access(
  p_tournament_id uuid,p_code text,p_referee_name text
) returns table(session_token uuid,tournament_id uuid,group_id uuid,
  group_name text,referee_name text,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare claimed record; named_session public.referee_sessions%rowtype;
begin
  p_referee_name:=regexp_replace(p_referee_name,'^[[:space:]]+|[[:space:]]+$','','g');
  if p_referee_name is null or p_referee_name='' then
    raise exception 'Tên trọng tài là bắt buộc';
  end if;
  -- Keep the exact production body: 5-digit validation, crypt verification,
  -- advisory/row locks, counters, lockout, assignment resolution and INSERT.
  select * into claimed from public._claim_secondary_referee_access(p_tournament_id,p_code);
  if not found then return; end if;
  -- Require the actual existing session model before touching the returned row.
  -- Failures roll back the claim too; never rename a primary/existing session.
  update public.referee_sessions s set referee_name=p_referee_name
    from public.get_referee_session(claimed.session_token) valid
    where s.id=claimed.session_token and s.is_secondary
      and s.tournament_id=p_tournament_id and s.tournament_id=claimed.tournament_id
      and s.group_id=claimed.group_id and s.referee_name=claimed.referee_name
      and s.expires_at=claimed.expires_at
      and valid.session_token=s.id and valid.tournament_id=s.tournament_id
      and valid.group_id=s.group_id
      and exists(select 1 from public.referee_access_codes c where c.id=s.access_code_id
        and c.tournament_id=s.tournament_id and c.group_id=s.group_id and c.event_id=s.event_id)
      and exists(select 1 from public.groups g where g.id=s.group_id
        and g.tournament_id=s.tournament_id and g.event_id=s.event_id)
    returning s.* into named_session;
  if not found then
    raise exception 'Unrecognized secondary referee session; review before applying' using errcode='42501';
  end if;
  -- Token remains referee_sessions.id; expiry and is_secondary are untouched.
  return query select named_session.id,named_session.tournament_id,named_session.group_id,
    claimed.group_name,named_session.referee_name,named_session.expires_at;
end $$;
revoke all on function public.claim_secondary_referee_access(uuid,text,text) from public;
grant execute on function public.claim_secondary_referee_access(uuid,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
