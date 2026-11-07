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
  if p_event='fd0a9f8b-0609-4b3c-825d-7d99384c5587' then
    select coalesce(jsonb_agg(x),'[]'::jsonb) into thirds
      from jsonb_array_elements(thirds) x
      where exists(select 1 from public.groups g where g.id=(x->>'group_id')::uuid and g.event_id=p_event and g.name='E');
  end if;
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
end $function$
;