alter table public.tournament_events add column knockout_series boolean not null default false;

create function public.create_competition_with_series(
 p_name text,p_event_type text,p_start_date date,p_start_time time,p_format text,
 p_expected_team_count integer,p_style text,p_court_count integer
) returns uuid language plpgsql security invoker set search_path='' as $$
declare tid uuid;
begin
 if auth.uid() is null then raise exception 'Vui lòng đăng nhập.' using errcode='42501'; end if;
 if p_format is distinct from 'doubles' then raise exception 'Seri A/B chỉ hỗ trợ đánh đôi.'; end if;
 tid:=public.create_competition_with_courts(p_name,p_event_type,p_start_date,p_start_time,p_format,p_expected_team_count,p_style,p_court_count);
 update public.tournament_events set knockout_series=true where tournament_id=tid and is_default;
 if not found then raise exception 'Không tìm thấy nội dung mặc định.'; end if;
 return tid;
end $$;
revoke all on function public.create_competition_with_series(text,text,date,time,text,integer,text,integer) from public;
grant execute on function public.create_competition_with_series(text,text,date,time,text,integer,text,integer) to authenticated;

create function pantry_knockout.series_b_ids(snapshot jsonb,n integer)
returns uuid[] language sql immutable set search_path='' as $$
 with candidates as (
  select (r->>'team_id')::uuid team_id,(r->>'group_position')::int pos,
         (r->>'point_difference')::int diff,(r->>'points_scored')::int points
  from jsonb_array_elements(snapshot->'standings') g
  cross join lateral jsonb_array_elements(g->'rows') r
  where not exists(select 1 from jsonb_array_elements(snapshot->'qualifiers') a where a->>'team_id'=r->>'team_id')
 ), ranked as (
  select *,row_number() over(partition by pos order by diff desc,points desc,team_id) rank from candidates
 ), selected as (
  select team_id,pos,rank from ranked
  where (pos=3 and rank<=4) or (pos=4 and rank<=case when n=6 then 6 else 4 end) or (pos=5 and n=6)
 ), limited as (
  select team_id from selected order by pos,rank limit 8
 )
 select array_agg(team_id order by team_id) from limited
$$;
revoke all on function pantry_knockout.series_b_ids(jsonb,integer) from public;

CREATE OR REPLACE FUNCTION pantry_knockout.check_graph()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e uuid; d public.knockout_decisions%rowtype; ids uuid[]; expected integer; series boolean;
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
       (case d.group_count when 2 then 4 when 3 then 8 when 4 then 8 when 5 then 11 else 16 end) then
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
        (case when d.group_count=2 then 'semifinal' when d.group_count in (3,4) then 'quarterfinal'
          when d.group_count=5 and (q->>'group_position')::integer=1 then 'quarterfinal'
          when d.group_count=5 then 'playoff' else 'round_of_16' end)) then
    raise exception 'Qualifier entry metadata differs from the supported format';
  end if;
  if d.state='resolved' then
    return null;
  end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into ids
    from public.matches where event_id=e and stage<>'group';
  select knockout_series into series from public.tournament_events where id=e;
  expected:=case d.group_count when 2 then 3 when 3 then 7 when 4 then 7 when 5 then 10 else 15 end;
  if cardinality(ids)<>expected+(case when series then 7 else 0 end) or ids is distinct from
      (select array_agg(x order by x) from unnest(d.match_ids) x) then
    raise exception 'Generated bracket membership differs from the saved revision' using errcode='PT409';
  end if;
  if exists(select 1 from public.matches where event_id=e and stage<>'group' and (
      group_id is not null or stage not in ('playoff','round_of_16','quarterfinal','semifinal','final'))) then
    raise exception 'Invalid managed knockout stage/group';
  end if;
  if (select count(*) from public.matches where event_id=e and stage='playoff' and match_code not like 'B-%')<>
       (case when d.group_count=5 then 3 else 0 end)
     or (select count(*) from public.matches where event_id=e and stage='round_of_16' and match_code not like 'B-%')<>
       (case when d.group_count>=6 then 8 else 0 end)
     or (select count(*) from public.matches where event_id=e and stage='quarterfinal' and match_code not like 'B-%')<>(case when d.group_count=2 then 0 else 4 end)
     or (select count(*) from public.matches where event_id=e and stage='semifinal' and match_code not like 'B-%')<>2
     or (select count(*) from public.matches where event_id=e and stage='final' and match_code not like 'B-%')<>1 then
    raise exception 'Round counts differ from the qualification format';
  end if;
  if (select count(*) from public.matches where event_id=e and stage<>'group' and match_code like 'B-%')<>(case when series then 7 else 0 end)
     or (series and (select array_agg(stage::text order by stage::text) from public.matches where event_id=e and stage<>'group' and match_code like 'B-%')
          is distinct from array['final','quarterfinal','quarterfinal','quarterfinal','quarterfinal','semifinal','semifinal']) then
    raise exception 'Invalid Seri B round counts';
  end if;
  -- Strict adjacent-stage edges prevent cycles (including multi-node cycles).
  if exists(
    select 1 from public.matches m
    cross join lateral (values(m.team1_source_match_id,m.team1_id),
                              (m.team2_source_match_id,m.team2_id)) slot(source_id,team_id)
    left join public.matches s on s.id=slot.source_id and s.event_id=m.event_id
    where m.event_id=e and m.stage<>'group' and slot.source_id is not null and (
      s.id is null or (s.match_code like 'B-%')<>(m.match_code like 'B-%') or not (
        (m.stage='quarterfinal' and m.match_code not like 'B-%' and ((d.group_count=5 and s.stage='playoff')
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
      ((m.stage='final' or (m.stage='semifinal' and d.group_count<>2)) and (m.team1_source_match_id is null or m.team2_source_match_id is null))
      or (m.stage='quarterfinal' and m.match_code not like 'B-%' and d.group_count>=6 and
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
      where m.event_id=e and m.stage<>'group' and m.match_code not like 'B-%' and slot.source_id is null)
     is distinct from (select array_agg((q->>'team_id')::uuid order by (q->>'team_id')::uuid)
       from jsonb_array_elements(d.snapshot->'qualifiers') q) then
    raise exception 'Direct entrants differ from the saved qualification decision';
  end if;
  if series and (
    select array_agg(slot.team_id order by slot.team_id) from public.matches m
    cross join lateral (values(m.team1_source_match_id,m.team1_id),(m.team2_source_match_id,m.team2_id)) slot(source_id,team_id)
    where m.event_id=e and m.stage<>'group' and m.match_code like 'B-%' and slot.source_id is null
  ) is distinct from pantry_knockout.series_b_ids(d.snapshot,d.group_count) then
    raise exception 'Seri B entrants differ from the standings';
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
declare rev bigint; n integer; node jsonb; ids uuid[]:='{}'; mapping jsonb:='{}'; mid uuid; tour uuid; series boolean;
begin
  rev:=pantry_knockout.prepare_generation(p_event,p_expected_revision,p_confirm_regeneration);
  -- Lock existing qualification inputs for this transaction. The fingerprint also
  -- rejects edits made between preview and acquiring these locks.
  perform 1 from public.groups where event_id=p_event for share;
  perform 1 from public.group_teams where event_id=p_event for share;
  perform 1 from public.matches where event_id=p_event and stage='group' for share;
  n:=pantry_knockout.validate_snapshot(p_event,p_snapshot);
  select tournament_id,knockout_series into tour,series from public.tournament_events where id=p_event;
  if series and (n not between 4 and 8 or coalesce(cardinality(pantry_knockout.series_b_ids(p_snapshot,n)),0)<>8) then
    raise exception 'Seri B cần đủ tám đội theo điều lệ và từ bốn đến tám bảng.';
  end if;
  if jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes)<>(case n when 2 then 3 when 3 then 7 when 4 then 7 when 5 then 10 else 15 end)+(case when series then 7 else 0 end) then raise exception 'Invalid bracket size'; end if;
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
