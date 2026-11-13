-- Extend existing guarded knockout format to three groups.
alter table public.knockout_decisions drop constraint knockout_decisions_group_count_check;
alter table public.knockout_decisions add constraint knockout_decisions_group_count_check check (group_count between 3 and 8);

CREATE OR REPLACE FUNCTION pantry_knockout.validate_snapshot(p_event uuid, p_snapshot jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if n not between 3 and 8 or jsonb_array_length(p_snapshot->'standings') is distinct from n then
    raise exception 'Requires 3–8 groups';
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
          'entry_stage',case when n in (3,4) then 'quarterfinal' when n=5 and pos=1 then 'quarterfinal'
            when n=5 then 'playoff' else 'round_of_16' end);
        if pos<=2 then expected:=expected||jsonb_build_array(q); else thirds:=thirds||jsonb_build_array(q); end if;
      end if;
    end loop;
  end loop;
  if n=5 and p_event='fd0a9f8b-0609-4b3c-825d-7d99384c5587' then
    select coalesce(jsonb_agg(x),'[]'::jsonb) into thirds
      from jsonb_array_elements(thirds) x
      where exists(select 1 from public.groups g where g.id=(x->>'group_id')::uuid and g.event_id=p_event and g.name='E');
  end if;
  wildcard_count:=case n when 3 then 2 when 5 then 1 when 6 then 4 when 7 then 2 else 0 end;
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
end $function$
;

CREATE OR REPLACE FUNCTION pantry_knockout.check_graph()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e uuid; d public.knockout_decisions%rowtype; ids uuid[]; expected integer;
begin
  e:=case when tg_op='DELETE' then old.event_id else new.event_id end;
  if not exists(select 1 from public.tournament_events where id=e) then return null; end if;
  select * into d from public.knockout_decisions where event_id=e;
  if not found then return null; end if;
  if d.state<>'generated' then
    -- A previously managed bracket cannot be deactivated by committing the
    -- intermediate regeneration state. Full event deletion still returns above.
    if tg_table_name='knockout_decisions' and tg_op='UPDATE' then
      if old.state='generated' then
        raise exception 'Regeneration must finish atomically in generated state' using errcode='PT409';
      end if;
    end if;
    -- Draft metadata must not constrain any ordinary legacy match/subgame write.
    if tg_table_name<>'knockout_decisions' then return null; end if;
  else
    if tg_table_name='matches' then
      if tg_op='DELETE' then
        if old.stage='group' then return null; end if;
      elsif new.stage='group' and (tg_op='INSERT' or old.stage='group') then
        return null;
      end if;
    elsif tg_table_name='mlp_games' then
      if not exists(select 1 from public.matches m where m.event_id=e and m.stage<>'group'
          and ((tg_op<>'INSERT' and m.id=old.match_id)
            or (tg_op<>'DELETE' and m.id=new.match_id))) then return null; end if;
    end if;
    perform pantry_knockout.require_supported_scoring(e);
  end if;
  -- Validate snapshot identity/shape without introducing any ranking formula.
  if jsonb_array_length(d.snapshot->'standings')<>d.group_count
     or jsonb_array_length(d.snapshot->'qualifiers')<>
       (case d.group_count when 3 then 8 when 4 then 8 when 5 then 11 else 16 end) then
    raise exception 'Qualification snapshot size differs from its format';
  end if;
  if exists(select 1 from jsonb_array_elements(d.snapshot->'qualifiers') q
      left join public.teams t on t.id=(q->>'team_id')::uuid and t.event_id=e
      left join public.groups g on g.id=(q->>'group_id')::uuid and g.event_id=e
      where t.id is null or g.id is null
        or not (q ?& array['team_id','group_id','group_position','qualification_type',
                          'point_difference','points_scored','entry_stage'])
        or jsonb_typeof(q->'group_position') is distinct from 'number'
        or (q->>'group_position')::integer not between 1 and 3
        or jsonb_typeof(q->'point_difference') is distinct from 'number'
        or jsonb_typeof(q->'points_scored') is distinct from 'number'
        or jsonb_typeof(q->'qualification_type') is distinct from 'string'
        or jsonb_typeof(q->'entry_stage') is distinct from 'string'
        or q->>'qualification_type' not in ('group_winner','runner_up','wildcard_third')) then
    raise exception 'Invalid or cross-event qualification identity/metrics';
  end if;
  if exists(select 1 from jsonb_array_elements(d.snapshot->'qualifiers') q
      where q->>'qualification_type' is distinct from
        (case (q->>'group_position')::integer when 1 then 'group_winner'
          when 2 then 'runner_up' else 'wildcard_third' end)
      or q->>'entry_stage' is distinct from
        (case when d.group_count in (3,4) then 'quarterfinal'
          when d.group_count=5 and (q->>'group_position')::integer=1 then 'quarterfinal'
          when d.group_count=5 then 'playoff' else 'round_of_16' end)) then
    raise exception 'Qualifier entry metadata differs from the supported format';
  end if;
  if d.state='resolved' then
    return null;
  end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into ids
    from public.matches where event_id=e and stage<>'group';
  expected:=case d.group_count when 3 then 7 when 4 then 7 when 5 then 10 else 15 end;
  if cardinality(ids)<>expected or ids is distinct from
      (select array_agg(x order by x) from unnest(d.match_ids) x) then
    raise exception 'Generated bracket membership differs from the saved revision' using errcode='PT409';
  end if;
  if exists(select 1 from public.matches where event_id=e and stage<>'group' and (
      group_id is not null or stage not in ('playoff','round_of_16','quarterfinal','semifinal','final'))) then
    raise exception 'Invalid managed knockout stage/group';
  end if;
  if (select count(*) from public.matches where event_id=e and stage='playoff')<>
       (case when d.group_count=5 then 3 else 0 end)
     or (select count(*) from public.matches where event_id=e and stage='round_of_16')<>
       (case when d.group_count>=6 then 8 else 0 end)
     or (select count(*) from public.matches where event_id=e and stage='quarterfinal')<>4
     or (select count(*) from public.matches where event_id=e and stage='semifinal')<>2
     or (select count(*) from public.matches where event_id=e and stage='final')<>1 then
    raise exception 'Round counts differ from the qualification format';
  end if;
  -- Strict adjacent-stage edges prevent cycles (including multi-node cycles).
  if exists(
    select 1 from public.matches m
    cross join lateral (values(m.team1_source_match_id,m.team1_id),
                              (m.team2_source_match_id,m.team2_id)) slot(source_id,team_id)
    left join public.matches s on s.id=slot.source_id and s.event_id=m.event_id
    where m.event_id=e and m.stage<>'group' and slot.source_id is not null and (
      s.id is null or not (
        (m.stage='quarterfinal' and ((d.group_count=5 and s.stage='playoff')
          or (d.group_count>=6 and s.stage='round_of_16')))
        or (m.stage='semifinal' and s.stage='quarterfinal')
        or (m.stage='final' and s.stage='semifinal'))
      or slot.team_id is distinct from (case when s.status='completed' then s.winner_id end))
  ) then
    raise exception 'Source path/participant mismatch; advance in the same transaction' using errcode='PT409';
  end if;
  if exists(select 1 from (
      select team1_source_match_id id from public.matches where event_id=e
      union all select team2_source_match_id from public.matches where event_id=e
    ) sources where id is not null group by id having count(*)<>1) then
    raise exception 'An upstream winner may feed only one slot';
  end if;
  if exists(select 1 from public.matches m where m.event_id=e and (
      (m.stage in ('semifinal','final') and (m.team1_source_match_id is null or m.team2_source_match_id is null))
      or (m.stage='quarterfinal' and d.group_count>=6 and
          (m.team1_source_match_id is null or m.team2_source_match_id is null)))) then
    raise exception 'Missing downstream source';
  end if;
  if d.group_count=5 and (select count(*) from public.matches m
      cross join lateral (values(m.team1_source_match_id),(m.team2_source_match_id)) slot(id)
      where m.event_id=e and m.stage='quarterfinal' and slot.id is not null)<>3 then
    raise exception 'Five-group QF requires exactly three playoff sources and five direct entrants';
  end if;
  -- A direct entry appears exactly once. The snapshot determines the entrants;
  -- actual qualification/ranking and draw semantics belong to the future engine.
  if exists(select 1 from public.matches m
      cross join lateral (values(m.team1_source_match_id,m.team1_id),
                                (m.team2_source_match_id,m.team2_id)) slot(source_id,team_id)
      where m.event_id=e and m.stage<>'group' and slot.source_id is null and slot.team_id is null) then
    raise exception 'Direct entrant cannot be null';
  end if;
  if (select array_agg(slot.team_id order by slot.team_id) from public.matches m
      cross join lateral (values(m.team1_source_match_id,m.team1_id),
                                (m.team2_source_match_id,m.team2_id)) slot(source_id,team_id)
      where m.event_id=e and m.stage<>'group' and slot.source_id is null)
     is distinct from (select array_agg((q->>'team_id')::uuid order by (q->>'team_id')::uuid)
       from jsonb_array_elements(d.snapshot->'qualifiers') q) then
    raise exception 'Direct entrants differ from the saved qualification decision';
  end if;
  if exists(select 1 from public.matches m
      cross join lateral (values(m.team1_source_match_id,m.team1_id),
                                (m.team2_source_match_id,m.team2_id)) slot(source_id,team_id)
      join lateral jsonb_array_elements(d.snapshot->'qualifiers') q
        on (q->>'team_id')::uuid=slot.team_id
      where m.event_id=e and m.stage<>'group' and slot.source_id is null
        and m.stage is distinct from q->>'entry_stage') then
    raise exception 'Direct entrant is placed in the wrong entry round';
  end if;
  if exists(select 1 from jsonb_array_elements(d.snapshot->'qualifiers') q
      group by q->>'team_id' having count(*)>1) then
    raise exception 'Duplicate qualified team';
  end if;
  if exists(select 1 from public.matches m where m.event_id=e and m.stage<>'group'
      and (m.status in ('playing','completed') or pantry_knockout.has_play(m.id))
      and (m.team1_id is null or m.team2_id is null or m.team1_id=m.team2_id)) then
    raise exception 'Started match participants must be resolved and distinct';
  end if;
  if exists(select 1 from public.matches m where m.event_id=e and m.stage<>'group'
      and m.status='completed' and (m.winner_id is null or
        m.winner_id is distinct from m.team1_id and m.winner_id is distinct from m.team2_id)) then
    raise exception 'Completed parent winner must be a participant';
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION pantry_knockout.generate(p_event uuid, p_expected_revision bigint, p_confirm_regeneration boolean, p_snapshot jsonb, p_nodes jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rev bigint; n integer; node jsonb; ids uuid[]:='{}'; mapping jsonb:='{}'; mid uuid; tour uuid;
begin
  rev:=pantry_knockout.prepare_generation(p_event,p_expected_revision,p_confirm_regeneration);
  -- Lock existing qualification inputs for this transaction. The fingerprint also
  -- rejects edits made between preview and acquiring these locks.
  perform 1 from public.groups where event_id=p_event for share;
  perform 1 from public.group_teams where event_id=p_event for share;
  perform 1 from public.matches where event_id=p_event and stage='group' for share;
  n:=pantry_knockout.validate_snapshot(p_event,p_snapshot);
  if jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes)<>(case n when 3 then 7 when 4 then 7 when 5 then 10 else 15 end) then raise exception 'Invalid bracket size'; end if;
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
end $function$
;
