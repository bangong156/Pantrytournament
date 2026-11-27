create table pantry_knockout.entrant_replacements (
 match_id uuid not null references public.matches(id) on delete cascade,
 side integer not null check (side in (1,2)),
 original_team_id uuid not null,
 replacement_team_id uuid not null,
 replaced_by uuid not null,
 replaced_at timestamptz not null default clock_timestamp(),
 primary key(match_id,side)
);
revoke all on pantry_knockout.entrant_replacements from public,anon,authenticated;

create function pantry_knockout.replacement_allowed(match_id uuid,side integer,source_id uuid,old_team uuid,new_team uuid)
returns boolean language sql stable set search_path='' as $$
 select coalesce((select $5 is not distinct from r.replacement_team_id
  from pantry_knockout.entrant_replacements r where r.match_id=$1 and r.side=$2),
  $3 is not null or $4 is not distinct from $5)
$$;
revoke all on function pantry_knockout.replacement_allowed(uuid,integer,uuid,uuid,uuid) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION pantry_knockout.guard_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e uuid; d public.knockout_decisions%rowtype; old_winner uuid; new_winner uuid;
begin
  if tg_op='DELETE' then
    if old.stage='group' then return old; end if;
    e:=old.event_id;
  else
    if new.stage='group' and (tg_op='INSERT' or old.stage='group') then return new; end if;
    e:=new.event_id;
  end if;
  -- Unmanaged matches (including legacy knockout and resolved-only decisions)
  -- return BEFORE the lock/isolation check. Existing scoring/court writes retain
  -- their original behavior. Only explicit generation/decision writes lock early.
  if not pantry_knockout.is_managed(e) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  perform pantry_knockout.lock_event(e);
  select * into d from public.knockout_decisions where event_id=e;
  if not found or d.state<>'generated' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  -- Deferred graph validation rejects partial deletions while allowing the
  -- existing admin delete_tournament RPC to remove the entire event atomically.
  if tg_op='DELETE' then return old; end if;
  if tg_op='INSERT' and d.state='generated' then
    raise exception 'Generated bracket is immutable; explicit regeneration required';
  end if;
  if tg_op='UPDATE' and d.state='generated' then
    -- Keep a per-match play marker as well as the event latch: resetting score
    -- fields must not make a previously played participant replaceable later.
    if old.started_at is not null then new.started_at:=old.started_at; end if;
    if row(new.id,new.event_id,new.tournament_id,new.group_id,new.stage,new.match_code,
           new.scheduled_order,new.team1_source_match_id,new.team2_source_match_id)
       is distinct from row(old.id,old.event_id,old.tournament_id,old.group_id,old.stage,old.match_code,
           old.scheduled_order,old.team1_source_match_id,old.team2_source_match_id)
       or not pantry_knockout.replacement_allowed(old.id,1,old.team1_source_match_id,old.team1_id,new.team1_id)
       or not pantry_knockout.replacement_allowed(old.id,2,old.team2_source_match_id,old.team2_id,new.team2_id) then
      raise exception 'Generated bracket topology/direct entrants are immutable' using errcode='PT409';
    end if;
    if row(new.team1_id,new.team2_id) is distinct from row(old.team1_id,old.team2_id)
       and pantry_knockout.has_play(old.id) then
      raise exception 'Downstream match has started; manual resolution required' using errcode='PT409';
    end if;
    old_winner:=case when old.status='completed' then old.winner_id end;
    new_winner:=case when new.status='completed' then new.winner_id end;
    if new_winner is distinct from old_winner and exists(
      with recursive downstream(id) as (
        select m.id from public.matches m where m.event_id=e
          and (m.team1_source_match_id=old.id or m.team2_source_match_id=old.id)
        union
        select m.id from public.matches m join downstream s
          on m.team1_source_match_id=s.id or m.team2_source_match_id=s.id where m.event_id=e
      ) select 1 from downstream where pantry_knockout.has_play(id)
    ) then
      raise exception 'Result correction affects a started downstream match; manual resolution required'
        using errcode='PT409';
    end if;
  end if;
  if new.status in ('playing','completed') or new.started_at is not null
     or new.completed_at is not null or new.team1_score is not null or new.team2_score is not null then
    if d.state<>'generated' then raise exception 'Bracket generation is not complete'; end if;
    if new.team1_id is null or new.team2_id is null then raise exception 'Participants unresolved'; end if;
    new.started_at:=coalesce(new.started_at,clock_timestamp());
    update public.knockout_decisions set started_at=clock_timestamp()
      where event_id=e and started_at is null;
  end if;
  return new;
end $function$ ;
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
    cross join lateral (values(1,m.team1_source_match_id,m.team1_id),(2,m.team2_source_match_id,m.team2_id)) slot(side,source_id,team_id)
    left join pantry_knockout.entrant_replacements r on r.match_id=m.id and r.side=slot.side
    left join public.matches s on s.id=slot.source_id and s.event_id=m.event_id
    where m.event_id=e and m.stage<>'group' and slot.source_id is not null and (
      s.id is null or (s.match_code like 'B-%')<>(m.match_code like 'B-%') or not (
        (m.stage='quarterfinal' and m.match_code not like 'B-%' and ((d.group_count=5 and s.stage='playoff')
          or (d.group_count>=6 and s.stage='round_of_16')))
        or (m.stage='semifinal' and s.stage='quarterfinal')
        or (m.stage='final' and s.stage='semifinal'))
      or slot.team_id is distinct from (case when s.status='completed' then coalesce(r.replacement_team_id,s.winner_id) end))
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
  if (select array_agg(coalesce(r.original_team_id,slot.team_id) order by coalesce(r.original_team_id,slot.team_id)) from public.matches m
      cross join lateral (values(1,m.team1_source_match_id,m.team1_id),(2,m.team2_source_match_id,m.team2_id)) slot(side,source_id,team_id)
      left join pantry_knockout.entrant_replacements r on r.match_id=m.id and r.side=slot.side
      where m.event_id=e and m.stage<>'group' and m.match_code not like 'B-%' and slot.source_id is null)
     is distinct from (select array_agg((q->>'team_id')::uuid order by (q->>'team_id')::uuid)
       from jsonb_array_elements(d.snapshot->'qualifiers') q) then
    raise exception 'Direct entrants differ from the saved qualification decision';
  end if;
  if series and (
    select array_agg(coalesce(r.original_team_id,slot.team_id) order by coalesce(r.original_team_id,slot.team_id)) from public.matches m
    cross join lateral (values(1,m.team1_source_match_id,m.team1_id),(2,m.team2_source_match_id,m.team2_id)) slot(side,source_id,team_id)
      left join pantry_knockout.entrant_replacements r on r.match_id=m.id and r.side=slot.side
    where m.event_id=e and m.stage<>'group' and m.match_code like 'B-%' and slot.source_id is null
  ) is distinct from pantry_knockout.series_b_ids(d.snapshot,d.group_count) then
    raise exception 'Seri B entrants differ from the standings';
  end if;
  if exists(select 1 from public.matches m
      cross join lateral (values(1,m.team1_source_match_id,m.team1_id),(2,m.team2_source_match_id,m.team2_id)) slot(side,source_id,team_id)
      left join pantry_knockout.entrant_replacements r on r.match_id=m.id and r.side=slot.side
      join lateral jsonb_array_elements(d.snapshot->'qualifiers') q
        on (q->>'team_id')::uuid=coalesce(r.original_team_id,slot.team_id)
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
end $function$ ;

create function public.pantry_knockout_replacement_candidates(p_event uuid)
returns table(id uuid,name text) language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or public.is_admin() is not true
    or public._competition_write_scope(p_event) is not true then
   raise exception 'Chỉ admin được xem danh sách cặp dự bị.' using errcode='42501';
 end if;
 return query select t.id,t.name::text from public.teams t where t.event_id=p_event
  and not exists(select 1 from public.matches m where m.event_id=p_event and m.stage<>'group' and t.id in(m.team1_id,m.team2_id))
  and not exists(select 1 from public.knockout_decisions d cross join lateral jsonb_array_elements(d.snapshot->'qualifiers') q
      where d.event_id=p_event and q->>'team_id'=t.id::text)
  and not exists(select 1 from pantry_knockout.entrant_replacements r join public.matches prior on prior.id=r.match_id
      where prior.event_id=p_event and r.original_team_id=t.id)
  order by t.name,t.id;
end $$;
revoke all on function public.pantry_knockout_replacement_candidates(uuid) from public,anon;
grant execute on function public.pantry_knockout_replacement_candidates(uuid) to authenticated;

create function public.pantry_knockout_replace_team(p_event uuid,p_match uuid,p_side integer,p_previous uuid,p_replacement uuid)
returns void language plpgsql security definer set search_path='' as $$
declare m public.matches%rowtype; previous uuid;
begin
 if auth.uid() is null or public.is_admin() is not true
    or public._competition_write_scope(p_event) is not true then
   raise exception 'Chỉ admin được thay đội Knockout.' using errcode='42501';
 end if;
 perform pantry_knockout.lock_event(p_event);
 select * into m from public.matches where id=p_match and event_id=p_event for update;
 if not found or m.stage='group' or not pantry_knockout.is_managed(p_event) then
  raise exception 'Không tìm thấy trận trong nhánh Knockout.';
 end if;
 if m.status is distinct from 'scheduled' or pantry_knockout.has_play(m.id) then
  raise exception 'Chỉ thay đội ở trận chưa bắt đầu.' using errcode='PT409';
 end if;
 if p_side is null or p_side not in (1,2) then raise exception 'Vị trí đội không hợp lệ.'; end if;
 previous:=case when p_side=1 then m.team1_id else m.team2_id end;
 if previous is null or previous is distinct from p_previous then
  raise exception 'Đội đã thay đổi. Vui lòng tải lại nhánh.' using errcode='PT409';
 end if;
 if not exists(select 1 from public.teams where id=p_replacement and event_id=p_event)
    or exists(select 1 from public.matches where event_id=p_event and stage<>'group' and p_replacement in (team1_id,team2_id))
    or exists(select 1 from public.knockout_decisions d cross join lateral jsonb_array_elements(d.snapshot->'qualifiers') q
      where d.event_id=p_event and q->>'team_id'=p_replacement::text)
    or exists(select 1 from pantry_knockout.entrant_replacements r join public.matches prior on prior.id=r.match_id
      where prior.event_id=p_event and r.original_team_id=p_replacement) then
  raise exception 'Cặp thay thế phải thuộc nội dung này và chưa có suất Knockout.' using errcode='PT409';
 end if;
 insert into pantry_knockout.entrant_replacements(match_id,side,original_team_id,replacement_team_id,replaced_by)
 values(m.id,p_side,previous,p_replacement,auth.uid())
 on conflict (match_id,side) do update set replacement_team_id=excluded.replacement_team_id,
  replaced_by=excluded.replaced_by,replaced_at=clock_timestamp();
 update public.matches set team1_id=case when p_side=1 then p_replacement else team1_id end,
  team2_id=case when p_side=2 then p_replacement else team2_id end,
  score_version=coalesce(score_version,0)+1 where id=m.id;
 set constraints all immediate;
end $$;
revoke all on function public.pantry_knockout_replace_team(uuid,uuid,integer,uuid,uuid) from public,anon;
grant execute on function public.pantry_knockout_replace_team(uuid,uuid,integer,uuid,uuid) to authenticated;

