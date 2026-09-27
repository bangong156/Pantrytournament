-- Required follow-up: the applied preparation exposes no transactional writer.
-- Reuses its private locks, graph guards, revision checks and MLP deployment gate.
begin;

create function pantry_knockout.authorize(p_event uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.is_staff() or not public._competition_write_scope(p_event) then
    raise exception 'Staff/event authorization required' using errcode='42501';
  end if;
end $$;

create function pantry_knockout.inputs(p_event uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.id) from public.groups g where event_id=p_event),'[]'),
    'links',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.group_teams l where event_id=p_event),'[]'),
    'matches',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'group_id',m.group_id,
      'team1_id',m.team1_id,'team2_id',m.team2_id,'team1_score',m.team1_score,
      'team2_score',m.team2_score,'winner_id',m.winner_id,'status',m.status) order by m.id)
      from public.matches m where event_id=p_event and stage='group'),'[]'))
$$;

create function pantry_knockout.read_inputs(p_event uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform pantry_knockout.authorize(p_event);
  return pantry_knockout.inputs(p_event);
end $$;

-- Validate the existing standings order, without inventing a new tie breaker.
-- Equal W/difference/points rows retain exactly the supplied Pantry order.
create function pantry_knockout.validate_snapshot(p_event uuid,p_snapshot jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer; g jsonb; r jsonb; q jsonb; d jsonb; c jsonb;
  gid uuid; tid uuid; pos integer; w integer; pf integer; pa integer;
  prev_w integer; prev_diff integer; prev_pf integer;
  actual_ids uuid[]; supplied_ids uuid[]; tied_ids uuid[]; ordered_ids uuid[];
  thirds jsonb:='[]'; expected jsonb:='[]'; sorted_thirds jsonb;
  wildcard_count integer; cutoff jsonb; cutoff_count integer;
begin
  if p_snapshot->'input_state' is distinct from pantry_knockout.inputs(p_event) then
    raise exception 'Group results changed since preview; reload' using errcode='PT409';
  end if;
  select count(*) into n from public.groups where event_id=p_event;
  if n not between 4 and 8 or jsonb_array_length(p_snapshot->'standings') is distinct from n then
    raise exception 'Requires 4–8 groups';
  end if;
  if not exists(select 1 from public.matches where event_id=p_event and stage='group')
     or exists(select 1 from public.matches where event_id=p_event and stage='group' and status<>'completed') then
    raise exception 'Complete all group matches before qualification';
  end if;
  select array_agg(id order by id) into actual_ids from public.groups where event_id=p_event;
  select array_agg((x->>'group_id')::uuid order by (x->>'group_id')::uuid) into supplied_ids
    from jsonb_array_elements(p_snapshot->'standings') x;
  if actual_ids is distinct from supplied_ids then raise exception 'Wrong event groups'; end if;
  for g in select value from jsonb_array_elements(p_snapshot->'standings') loop
    gid:=(g->>'group_id')::uuid; pos:=0;prev_w:=null;
    select array_agg(team_id order by team_id) into actual_ids from public.group_teams where event_id=p_event and group_id=gid;
    select array_agg((x->>'team_id')::uuid order by (x->>'team_id')::uuid) into supplied_ids from jsonb_array_elements(g->'rows') x;
    if cardinality(actual_ids)<2 or actual_ids is distinct from supplied_ids then raise exception 'Wrong group membership'; end if;
    for r in select value from jsonb_array_elements(g->'rows') loop
      pos:=pos+1;tid:=(r->>'team_id')::uuid;
      select count(*) filter(where m.winner_id=tid),
        coalesce(sum(case when m.team1_id=tid then m.team1_score else m.team2_score end),0),
        coalesce(sum(case when m.team1_id=tid then m.team2_score else m.team1_score end),0)
        into w,pf,pa from public.matches m where m.event_id=p_event and m.stage='group'
        and m.group_id=gid and m.status='completed' and tid in (m.team1_id,m.team2_id);
      if (r->>'wins')::integer is distinct from w or (r->>'points_scored')::integer is distinct from pf
        or (r->>'point_difference')::integer is distinct from pf-pa
        or (r->>'group_position')::integer is distinct from pos then raise exception 'Stale standings metrics'; end if;
      if prev_w is not null and row(w,pf-pa,pf)>row(prev_w,prev_diff,prev_pf) then raise exception 'Invalid Pantry standings order'; end if;
      prev_w:=w;prev_diff:=pf-pa;prev_pf:=pf;
      if pos<=3 then
        q:=jsonb_build_object('team_id',tid,'group_id',gid,'group_position',pos,
          'point_difference',pf-pa,'points_scored',pf,'qualification_type',
          case pos when 1 then 'group_winner' when 2 then 'runner_up' else 'wildcard_third' end,
          'entry_stage',case when n=4 then 'quarterfinal' when n=5 and pos=1 then 'quarterfinal'
            when n=5 then 'playoff' else 'round_of_16' end);
        if pos<=2 then expected:=expected||jsonb_build_array(q); else thirds:=thirds||jsonb_build_array(q); end if;
      end if;
    end loop;
  end loop;
  wildcard_count:=case n when 5 then 1 when 6 then 4 when 7 then 2 else 0 end;
  if jsonb_array_length(thirds)<wildcard_count then raise exception 'Not enough third-place teams'; end if;
  -- Every persisted draw must be an exact full permutation of one metric tie.
  for d in select value from jsonb_array_elements(p_snapshot->'draws') loop
    if d->>'method' is distinct from 'admin_draw' or (d->>'group_position')::integer is distinct from 3 then raise exception 'Invalid draw'; end if;
    select array_agg((x->>'team_id')::uuid order by (x->>'team_id')::uuid) into tied_ids
      from jsonb_array_elements(thirds) x where x->'point_difference'=d->'point_difference' and x->'points_scored'=d->'points_scored';
    select array_agg(x::uuid order by x::uuid) into ordered_ids from jsonb_array_elements_text(d->'ordered_team_ids') x;
    if cardinality(tied_ids)<2 or tied_ids is distinct from ordered_ids then raise exception 'Draw must order the complete tied set'; end if;
    if (select count(*) from jsonb_array_elements(p_snapshot->'draws') x where x->'point_difference'=d->'point_difference' and x->'points_scored'=d->'points_scored')<>1 then raise exception 'Duplicate draw'; end if;
  end loop;
  select coalesce(jsonb_agg(x order by (x->>'point_difference')::integer desc,(x->>'points_scored')::integer desc,
    coalesce((select ord from jsonb_array_elements(p_snapshot->'draws') dd,
      jsonb_array_elements_text(dd->'ordered_team_ids') with ordinality a(id,ord) where a.id=x->>'team_id'),999),x->>'team_id'),'[]')
    into sorted_thirds from jsonb_array_elements(thirds) x;
  if wildcard_count>0 then
    cutoff:=sorted_thirds->(wildcard_count-1);
    select count(*) into cutoff_count from jsonb_array_elements(thirds) x
      where x->'point_difference'=cutoff->'point_difference' and x->'points_scored'=cutoff->'points_scored';
    if cutoff_count>1 and exists(select 1 from jsonb_array_elements(sorted_thirds) with ordinality a(x,i)
      where i>wildcard_count and x->'point_difference'=cutoff->'point_difference' and x->'points_scored'=cutoff->'points_scored')
      and not exists(select 1 from jsonb_array_elements(p_snapshot->'draws') x where x->'point_difference'=cutoff->'point_difference' and x->'points_scored'=cutoff->'points_scored') then
      raise exception 'Unresolved wildcard cutoff draw';
    end if;
    select expected||jsonb_agg(x order by i) into expected from jsonb_array_elements(sorted_thirds) with ordinality a(x,i) where i<=wildcard_count;
  end if;
  if jsonb_array_length(p_snapshot->'qualifiers') is distinct from jsonb_array_length(expected) then raise exception 'Incorrect qualifier count'; end if;
  for q in select value from jsonb_array_elements(expected) loop
    if (select count(*) from jsonb_array_elements(p_snapshot->'qualifiers') x where x @> q)<>1 then raise exception 'Incorrect qualified team/metrics'; end if;
  end loop;
  if jsonb_array_length(p_snapshot->'wildcard_candidates') is distinct from jsonb_array_length(sorted_thirds) then raise exception 'Incorrect wildcard candidates'; end if;
  for c in select value from jsonb_array_elements(sorted_thirds) loop
    if (select count(*) from jsonb_array_elements(p_snapshot->'wildcard_candidates') x where x @> c)<>1 then raise exception 'Incorrect wildcard candidate'; end if;
  end loop;
  return n;
end $$;

-- Save an initial draw independently so reloading the preview preserves it.
-- A generated bracket may only change its decision inside atomic regeneration.
create function pantry_knockout.resolve(p_event uuid,p_expected_revision bigint,p_snapshot jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare rev bigint; n integer;
begin
  rev:=pantry_knockout.prepare_generation(p_event,p_expected_revision,false);
  perform 1 from public.groups where event_id=p_event for share;
  perform 1 from public.group_teams where event_id=p_event for share;
  perform 1 from public.matches where event_id=p_event and stage='group' for share;
  n:=pantry_knockout.validate_snapshot(p_event,p_snapshot);
  if rev=0 then
    insert into public.knockout_decisions(event_id,group_count,format_version,revision,state,snapshot,resolved_at)
      values(p_event,n,'pantry-knockout-v1',1,'resolved',p_snapshot,clock_timestamp());
  else
    update public.knockout_decisions set group_count=n,revision=rev+1,snapshot=p_snapshot where event_id=p_event;
  end if;
  set constraints all immediate;
  return rev+1;
end $$;

create function pantry_knockout.generate(p_event uuid,p_expected_revision bigint,
  p_confirm_regeneration boolean,p_snapshot jsonb,p_nodes jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare rev bigint; n integer; node jsonb; ids uuid[]:='{}'; mapping jsonb:='{}'; mid uuid; tour uuid;
begin
  rev:=pantry_knockout.prepare_generation(p_event,p_expected_revision,p_confirm_regeneration);
  -- Lock existing qualification inputs for this transaction. The fingerprint also
  -- rejects edits made between preview and acquiring these locks.
  perform 1 from public.groups where event_id=p_event for share;
  perform 1 from public.group_teams where event_id=p_event for share;
  perform 1 from public.matches where event_id=p_event and stage='group' for share;
  n:=pantry_knockout.validate_snapshot(p_event,p_snapshot);
  if jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes)<>(case n when 4 then 7 when 5 then 10 else 15 end) then raise exception 'Invalid bracket size'; end if;
  select tournament_id into tour from public.tournament_events where id=p_event;
  if rev=0 then
    insert into public.knockout_decisions(event_id,group_count,format_version,revision,state,snapshot,resolved_at)
      values(p_event,n,'pantry-knockout-v1',1,'resolved',p_snapshot,clock_timestamp());
  else
    update public.knockout_decisions set group_count=n,revision=rev+1,state='resolved',snapshot=p_snapshot,
      match_ids='{}',generated_by=null,generated_at=null,started_at=null where event_id=p_event;
    delete from public.matches where event_id=p_event and stage<>'group';
  end if;
  for node in select value from jsonb_array_elements(p_nodes) loop
    if node->>'match_code' is null or mapping ? (node->>'match_code') then raise exception 'Duplicate/missing match code'; end if;
    mid:=gen_random_uuid();ids:=array_append(ids,mid);mapping:=mapping||jsonb_build_object(node->>'match_code',mid);
  end loop;
  for node in select value from jsonb_array_elements(p_nodes) loop
    if (node->>'team1_source_code' is not null and not mapping ? (node->>'team1_source_code'))
      or (node->>'team2_source_code' is not null and not mapping ? (node->>'team2_source_code')) then raise exception 'Unknown source match'; end if;
    insert into public.matches(id,event_id,tournament_id,match_code,stage,scheduled_order,status,
      team1_id,team2_id,team1_source_match_id,team2_source_match_id)
      values((mapping->>(node->>'match_code'))::uuid,p_event,tour,node->>'match_code',node->>'stage',
        (node->>'scheduled_order')::integer,'scheduled',(node->>'team1_id')::uuid,(node->>'team2_id')::uuid,
        (mapping->>(node->>'team1_source_code'))::uuid,(mapping->>(node->>'team2_source_code'))::uuid);
  end loop;
  update public.knockout_decisions set state='generated',match_ids=ids where event_id=p_event;
  -- Force the preparation's complete graph check before reporting success.
  set constraints all immediate;
  update public.tournament_events set status='knockout' where id=p_event;
  return rev+1;
end $$;

create function pantry_knockout.score(p_event uuid,p_match uuid,p_expected_revision bigint,
  p_expected_score_version bigint,p_score1 integer,p_score2 integer) returns void
language plpgsql security definer set search_path='' as $$
declare m public.matches%rowtype; d public.knockout_decisions%rowtype; winner uuid;
begin
  perform pantry_knockout.authorize(p_event);
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
end $$;

-- Invoker wrappers; only authorized private entry points are executable.
create function public.pantry_knockout_inputs(p_event uuid) returns jsonb
language sql security invoker set search_path='' as $$ select pantry_knockout.read_inputs(p_event) $$;
create function public.pantry_knockout_resolve(p_event uuid,p_expected_revision bigint,p_snapshot jsonb) returns bigint
language sql security invoker set search_path='' as $$ select pantry_knockout.resolve(p_event,p_expected_revision,p_snapshot) $$;
create function public.pantry_knockout_generate(p_event uuid,p_expected_revision bigint,p_confirm_regeneration boolean,p_snapshot jsonb,p_nodes jsonb) returns bigint
language sql security invoker set search_path='' as $$ select pantry_knockout.generate(p_event,p_expected_revision,p_confirm_regeneration,p_snapshot,p_nodes) $$;
create function public.pantry_knockout_score(p_event uuid,p_match uuid,p_expected_revision bigint,p_expected_score_version bigint,p_score1 integer,p_score2 integer) returns void
language sql security invoker set search_path='' as $$ select pantry_knockout.score(p_event,p_match,p_expected_revision,p_expected_score_version,p_score1,p_score2) $$;
revoke all on all functions in schema pantry_knockout from public,anon,authenticated,service_role;
grant usage on schema pantry_knockout to authenticated;
grant execute on function pantry_knockout.read_inputs(uuid),pantry_knockout.resolve(uuid,bigint,jsonb),
  pantry_knockout.generate(uuid,bigint,boolean,jsonb,jsonb),
  pantry_knockout.score(uuid,uuid,bigint,bigint,integer,integer) to authenticated;
revoke all on function public.pantry_knockout_inputs(uuid),public.pantry_knockout_resolve(uuid,bigint,jsonb),
  public.pantry_knockout_generate(uuid,bigint,boolean,jsonb,jsonb),
  public.pantry_knockout_score(uuid,uuid,bigint,bigint,integer,integer) from public,anon,service_role;
grant execute on function public.pantry_knockout_inputs(uuid),public.pantry_knockout_resolve(uuid,bigint,jsonb),
  public.pantry_knockout_generate(uuid,bigint,boolean,jsonb,jsonb),
  public.pantry_knockout_score(uuid,uuid,bigint,bigint,integer,integer) to authenticated;
commit;
