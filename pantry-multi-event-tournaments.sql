-- Pantry: multiple competition events. MANUAL Supabase migration; do not run older
-- feature patches afterwards (they contain tournament-scoped RPC definitions).
-- Requires the existing MLP, hardened referee/live score/custom point targets,
-- awards/tied-third, public roster and tournament-info migrations.
-- One transaction: any incompatible schema/data aborts the whole migration.
begin;

-- Fail closed if the installed feature set is older than this frontend expects.
do $$
declare signature text;
begin
  foreach signature in array array[
    'public.is_staff()', 'public.set_mlp_style(uuid,text)',
    'public.get_referee_session(uuid)', 'public.claim_referee_access(uuid,uuid,text,text)',
    'public.set_referee_code(uuid,uuid,text,timestamp with time zone)',
    'public.admin_referee_codes(uuid)', 'public.revoke_referee_code(uuid,uuid)', 'public.referee_live_state(uuid)',
    'public.referee_live_start(uuid,uuid,integer,boolean)',
    'public.referee_live_adjust(uuid,uuid,integer,integer,bigint,integer,integer,uuid)',
    'public.referee_live_finish(uuid,uuid,bigint,integer,integer)',
    'public.referee_submit_score(uuid,uuid,integer,integer)',
    'public.referee_submit_mlp_game(uuid,uuid,integer,text,integer,integer)',
    'public.public_tournament_roster(uuid)', 'public.delete_tournament(uuid)'
  ] loop
    if to_regprocedure(signature) is null then raise exception 'Missing prerequisite RPC: %',signature; end if;
  end loop;
  if has_any_column_privilege('anon','public.players','SELECT') then
    raise exception 'Missing player privacy prerequisite: anon still has player-column SELECT privileges';
  end if;
end $$;

-- Serialize with production writes while checking/backfilling. Reads continue
-- until each ALTER TABLE requires its normal schema lock.
lock table public.tournaments,public.teams,public.groups,public.matches,
  public.mlp_configs,public.mlp_slots,public.tournament_awards,
  public.referee_access_codes,public.referee_sessions,public.referee_score_logs,
  public.team_members,public.group_teams,public.mlp_games,public.referee_live_actions
  in share row exclusive mode;

-- Exact, transaction-local snapshots detect replacements/edits as well as lost
-- rows. Only event_id is excluded because assigning it is the intended change.
-- Original column lists ensure newly added planning columns do not affect checks.
create temporary table pantry_event_migration_counts(
  table_name text primary key,row_count bigint,preserved_columns text[]
) on commit drop;
create temporary table pantry_event_migration_rows(table_name text,row_data jsonb) on commit drop;
create temporary table pantry_event_migration_triggers(table_oid oid,trigger_name name,enabled "char") on commit drop;
revoke all on pantry_event_migration_counts,pantry_event_migration_rows,pantry_event_migration_triggers from public,anon,authenticated;
do $$
declare tbl text; n bigint; cols text[];
begin
  foreach tbl in array array['tournaments','teams','groups','matches','mlp_configs','mlp_slots',
    'tournament_awards','referee_access_codes','referee_sessions','referee_score_logs',
    'team_members','group_teams','mlp_games','referee_live_actions'] loop
    select array_agg(attname::text order by attnum) into cols from pg_attribute
      where attrelid=format('public.%I',tbl)::regclass and attnum>0 and not attisdropped and attname<>'event_id';
    execute format('select count(*) from public.%I',tbl) into n;
    insert into pantry_event_migration_counts values(tbl,n,cols);
    execute format('insert into pantry_event_migration_rows
      select %L,to_jsonb(r)-%L from public.%I r',tbl,'event_id',tbl);
  end loop;
end $$;

alter table public.tournaments add column if not exists start_time time;
alter table public.tournaments add column if not exists expected_team_count integer
  check (expected_team_count is null or expected_team_count > 0);

create table if not exists public.tournament_events (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  start_time time,
  format text not null check (format in ('doubles','mlp')),
  expected_team_count integer check (expected_team_count is null or expected_team_count > 0),
  sort_order integer not null default 0,
  is_default boolean not null default false,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,tournament_id)
);
create unique index if not exists tournament_events_one_default
  on public.tournament_events(tournament_id) where is_default;
create index if not exists tournament_events_order
  on public.tournament_events(tournament_id,sort_order,created_at);

-- Do not rewrite scores, names, identifiers, member identities, slots or settings.
insert into public.tournament_events
  (tournament_id,name,start_time,format,expected_team_count,is_default,status)
select t.id,'Nội dung chính',t.start_time,t.format::text,t.expected_team_count,true,coalesce(t.status::text,'draft')
from public.tournaments t
where not exists (select 1 from public.tournament_events e where e.tournament_id=t.id and e.is_default);

-- Backfill must not fire business/audit/timestamp UPDATE triggers. Save each
-- original mode and restore it immediately afterwards. Never disable internal FK
-- triggers, and never use session_replication_role. Write locks above cover this.
do $$
declare r record;
begin
  for r in select t.tgrelid,t.tgname,t.tgenabled from pg_trigger t
    join pantry_event_migration_counts m on t.tgrelid=format('public.%I',m.table_name)::regclass
    where not t.tgisinternal and m.table_name<>'tournaments'
      and t.tgenabled<>'D' and (t.tgtype::integer & 16)=16
  loop
    insert into pantry_event_migration_triggers values(r.tgrelid,r.tgname,r.tgenabled);
    execute format('alter table %s disable trigger %I',r.tgrelid::regclass,r.tgname);
  end loop;
end $$;

-- Root operational tables retain tournament_id. Children also get event_id,
-- derived from their existing parent, so cross-event links can be constrained.
do $$
declare tbl text;
begin
  foreach tbl in array array['teams','groups','matches','mlp_configs','mlp_slots',
    'tournament_awards','referee_access_codes','referee_sessions','referee_score_logs',
    'team_members','group_teams','mlp_games','referee_live_actions'] loop
    execute format('alter table public.%I add column if not exists event_id uuid',tbl);
    if exists (select 1 from pg_attribute where attrelid=format('public.%I',tbl)::regclass
               and attname='tournament_id' and not attisdropped) then
      execute format('update public.%I r set event_id=e.id from public.tournament_events e
                      where e.tournament_id=r.tournament_id and e.is_default and r.event_id is null',tbl);
    end if;
  end loop;
end $$;
update public.team_members r set event_id=t.event_id from public.teams t where r.team_id=t.id and r.event_id is null;
update public.group_teams r set event_id=g.event_id from public.groups g where r.group_id=g.id and r.event_id is null;
update public.mlp_games r set event_id=m.event_id from public.matches m where r.match_id=m.id and r.event_id is null;
update public.referee_live_actions r set event_id=m.event_id from public.matches m where r.match_id=m.id and r.event_id is null;

-- Flush original deferred FK checks before ALTER TABLE; fail with a useful table
-- name if an orphan could not be backfilled, before any new NOT NULL/PK is added.
set constraints all immediate;
do $$
declare r record; missing bigint;
begin
  for r in select table_name from pantry_event_migration_counts where table_name<>'tournaments' loop
    execute format('select count(*) from public.%I where event_id is null',r.table_name) into missing;
    if missing<>0 then raise exception 'Cannot backfill % rows in %; no changes committed',missing,r.table_name; end if;
  end loop;
  for r in select * from pantry_event_migration_triggers loop
    execute format('alter table %s %s trigger %I',r.table_oid::regclass,
      case r.enabled when 'A' then 'enable always' when 'R' then 'enable replica' else 'enable' end,r.trigger_name);
  end loop;
end $$;
-- New composite ownership FKs must be deferred across the original cascading
-- statements (in particular the ordered delete_tournament RPC).
set constraints all deferred;

-- Check known links explicitly, independently of which original FKs were
-- declared. Nullable history pointers are allowed; non-null mismatches abort.
do $$
declare edge record; invalid bigint;
begin
  for edge in select * from (values
    ('team_members','team_id','teams'),
    ('group_teams','group_id','groups'),('group_teams','team_id','teams'),
    ('matches','group_id','groups'),('matches','team1_id','teams'),
    ('matches','team2_id','teams'),('matches','winner_id','teams'),
    ('mlp_games','match_id','matches'),('mlp_games','winner_team_id','teams'),
    ('tournament_awards','team_id','teams'),
    ('referee_access_codes','group_id','groups'),
    ('referee_sessions','group_id','groups'),('referee_sessions','access_code_id','referee_access_codes'),
    ('referee_score_logs','group_id','groups'),('referee_score_logs','match_id','matches'),
    ('referee_score_logs','referee_session_id','referee_sessions'),
    ('referee_live_actions','match_id','matches'),('referee_live_actions','referee_session_id','referee_sessions')
  ) links(child_table,child_column,parent_table) loop
    execute format('select count(*) from public.%I c where c.%I is not null
      and not exists(select 1 from public.%I p where p.id=c.%I and p.event_id=c.event_id)',
      edge.child_table,edge.child_column,edge.parent_table,edge.child_column) into invalid;
    if invalid<>0 then raise exception 'Inconsistent legacy link %.%: % rows; no changes committed',
      edge.child_table,edge.child_column,invalid; end if;
  end loop;
end $$;

-- Replace ONLY tournament-wide uniqueness. Group/team/match UUID uniqueness is
-- already event-safe, and referee code ON CONFLICT(tournament_id,group_id) stays.
-- Catalog inspection accommodates constraint/index names in the original schema.
do $$
declare r record; definition text;
begin
  for r in
    select c.oid,c.conrelid,c.conname,c.contype,pg_get_constraintdef(c.oid) def
    from pg_constraint c
    where c.conrelid=any(array['public.teams'::regclass,'public.groups'::regclass,
      'public.matches'::regclass,'public.mlp_configs'::regclass,'public.mlp_slots'::regclass,
      'public.tournament_awards'::regclass]) and c.contype in ('u','p')
      and exists(select 1 from pg_attribute a where a.attrelid=c.conrelid
                 and a.attnum=any(c.conkey) and a.attname='tournament_id')
      and not exists(select 1 from pg_attribute a where a.attrelid=c.conrelid
                 and a.attnum=any(c.conkey) and a.attname in ('id','group_id','team_id','match_id'))
  loop
    -- A referenced key needs an explicit migration of its dependents; do not
    -- silently drop/repoint FKs or remove their ON DELETE behavior.
    if exists(select 1 from pg_constraint f join pg_constraint k on k.oid=r.oid
      where f.contype='f' and f.conindid=k.conindid) then
      raise exception 'Referenced tournament-wide key %.% needs schema review',r.conrelid::regclass,r.conname;
    end if;
    definition := replace(r.def,'tournament_id','event_id');
    execute format('alter table %s drop constraint %I',r.conrelid::regclass,r.conname);
    execute format('alter table %s add constraint %I %s',r.conrelid::regclass,r.conname,definition);
  end loop;
  for r in
    select i.indexrelid,pg_get_indexdef(i.indexrelid) def
    from pg_index i
    where i.indrelid=any(array['public.teams'::regclass,'public.groups'::regclass,
      'public.matches'::regclass,'public.mlp_configs'::regclass,'public.mlp_slots'::regclass,
      'public.tournament_awards'::regclass]) and i.indisunique
      and not exists(select 1 from pg_constraint c where c.conindid=i.indexrelid and c.contype in ('p','u','x'))
      and exists(select 1 from pg_attribute a where a.attrelid=i.indrelid
                 and a.attnum=any(i.indkey) and a.attname='tournament_id')
      and not exists(select 1 from pg_attribute a where a.attrelid=i.indrelid
                 and a.attnum=any(i.indkey) and a.attname in ('id','group_id','team_id','match_id'))
  loop
    if exists(select 1 from pg_constraint f where f.contype='f' and f.conindid=r.indexrelid) then
      raise exception 'Referenced tournament-wide index % needs schema review',r.indexrelid::regclass;
    end if;
    -- Replace column references, not the index name.
    definition := left(r.def,position(' USING ' in r.def)-1)||
      replace(substr(r.def,position(' USING ' in r.def)),'tournament_id','event_id');
    execute format('drop index %s',r.indexrelid::regclass);
    execute definition;
  end loop;
end $$;

-- Ensure explicit conflict targets even where the base schema had no constraint.
create unique index if not exists mlp_configs_event_uidx on public.mlp_configs(event_id);
create unique index if not exists mlp_slots_event_order_uidx on public.mlp_slots(event_id,slot_order);
create unique index if not exists tournament_awards_event_placement_uidx
  on public.tournament_awards(event_id,placement,placement_slot);

-- A missing parent or mismatched tournament aborts instead of discarding data.
do $$
declare tbl text; r record; fkname text; ukname text;
begin
  foreach tbl in array array['teams','groups','matches','mlp_configs','mlp_slots',
    'tournament_awards','referee_access_codes','referee_sessions','referee_score_logs',
    'team_members','group_teams','mlp_games','referee_live_actions'] loop
    execute format('alter table public.%I alter column event_id set not null',tbl);
    fkname:=tbl||'_competition_event_fk';
    if not exists(select 1 from pg_constraint where conrelid=format('public.%I',tbl)::regclass and conname=fkname) then
      -- NO ACTION allows existing tournament deletion cascades to finish. Direct
      -- event deletion cannot silently cascade competition data.
      execute format('alter table public.%I add constraint %I foreign key(event_id)
        references public.tournament_events(id) deferrable initially deferred',tbl,fkname);
    end if;
    execute format('create index if not exists %I on public.%I(event_id)',tbl||'_event_idx',tbl);
    if exists(select 1 from pg_attribute where attrelid=format('public.%I',tbl)::regclass and attname='tournament_id' and not attisdropped) then
      fkname:=tbl||'_event_tournament_fk';
      if not exists(select 1 from pg_constraint where conrelid=format('public.%I',tbl)::regclass and conname=fkname) then
        execute format('alter table public.%I add constraint %I foreign key(event_id,tournament_id)
          references public.tournament_events(id,tournament_id) deferrable initially deferred',tbl,fkname);
      end if;
    end if;
  end loop;
  -- Extend every original operational FK (including composite keys) with event ownership.
  -- Original ON DELETE actions remain in force (including SET NULL log history).
  for r in
    select c.conrelid,c.confrelid,c.conname,
      (select string_agg(format('%I',a.attname),',' order by k.ord)
       from unnest(c.conkey) with ordinality k(num,ord)
       join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num) local_cols,
      (select string_agg(format('%I',a.attname),',' order by k.ord)
       from unnest(c.confkey) with ordinality k(num,ord)
       join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num) parent_cols
    from pg_constraint c
    where c.contype='f'
      and not exists(select 1 from pg_attribute a where a.attrelid=c.conrelid
        and a.attnum=any(c.conkey) and a.attname='event_id')
      and c.conrelid=any(array['public.teams'::regclass,'public.groups'::regclass,'public.matches'::regclass,
        'public.mlp_configs'::regclass,'public.mlp_slots'::regclass,'public.tournament_awards'::regclass,
        'public.referee_access_codes'::regclass,'public.referee_sessions'::regclass,'public.referee_score_logs'::regclass,
        'public.team_members'::regclass,'public.group_teams'::regclass,'public.mlp_games'::regclass,'public.referee_live_actions'::regclass])
      and c.confrelid=any(array['public.teams'::regclass,'public.groups'::regclass,'public.matches'::regclass,
        'public.mlp_configs'::regclass,'public.mlp_slots'::regclass,
        'public.referee_access_codes'::regclass,'public.referee_sessions'::regclass])
      and c.conrelid<> 'public.tournament_events'::regclass
      and c.confrelid<> 'public.tournament_events'::regclass
      and exists(select 1 from pg_attribute x where x.attrelid=c.conrelid and x.attname='event_id' and not x.attisdropped)
      and exists(select 1 from pg_attribute x where x.attrelid=c.confrelid and x.attname='event_id' and not x.attisdropped)
  loop
    ukname:='event_parent_'||r.confrelid::text||'_'||substr(md5(r.parent_cols),1,16);
    if not exists(select 1 from pg_constraint where conrelid=r.confrelid and conname=ukname) then
      execute format('alter table %s add constraint %I unique(%s,event_id)',r.confrelid::regclass,ukname,r.parent_cols);
    end if;
    fkname:='event_link_'||substr(md5(r.conrelid::text||r.conname),1,24);
    if not exists(select 1 from pg_constraint where conrelid=r.conrelid and conname=fkname) then
      execute format('alter table %s add constraint %I foreign key(%s,event_id)
        references %s(%s,event_id) deferrable initially deferred',
        r.conrelid::regclass,fkname,r.local_cols,r.confrelid::regclass,r.parent_cols);
    end if;
  end loop;
end $$;

-- Existing clients that omit event_id continue writing to the default event.
-- Referee RPC inserts inherit the event from the authorized group/match/session.
create or replace function public._competition_assign_event()
returns trigger language plpgsql security definer set search_path='' as $$
declare v jsonb:=to_jsonb(new); candidate uuid; parent_event uuid; parent_table text; parent_column text;
begin
  if tg_op='UPDATE' then
    if new.event_id is distinct from old.event_id then
      raise exception 'Competition ownership cannot be changed';
    end if;
    -- Parent checks below consider only changed non-null references. A cascade
    -- may SET NULL one reference while another parent is already deleted.
    -- Unchanged references are validated by the deferred composite FKs.
  end if;
  candidate:=nullif(v->>'event_id','')::uuid;
  for parent_column,parent_table in select * from (values
    ('group_id','groups'),('team_id','teams'),('match_id','matches'),
    ('referee_session_id','referee_sessions'),('access_code_id','referee_access_codes'),
    ('team1_id','teams'),('team2_id','teams'),('winner_id','teams'),('winner_team_id','teams')
  ) links(col,tbl) loop
    if nullif(v->>parent_column,'') is not null
      and (tg_op='INSERT' or (v->>parent_column) is distinct from (to_jsonb(old)->>parent_column)) then
      execute format('select event_id from public.%I where id=$1',parent_table)
        into parent_event using (v->>parent_column)::uuid;
      if parent_event is null then raise exception 'Missing competition parent: %',parent_column; end if;
      if candidate is null then candidate:=parent_event;
      elsif candidate<>parent_event then raise exception 'Cross-event competition reference: %',parent_column; end if;
    end if;
  end loop;
  if tg_op='UPDATE' then return new; end if;
  if candidate is null then
    select id into candidate from public.tournament_events
    where tournament_id=(v->>'tournament_id')::uuid and is_default;
  end if;
  if candidate is null then raise exception 'Competition event required'; end if;
  -- Serialize data creation against event deletion / format changes.
  perform 1 from public.tournament_events where id=candidate for share;
  if not found then raise exception 'Competition event not found'; end if;
  new.event_id:=candidate;
  return new;
end $$;
revoke all on function public._competition_assign_event() from public,anon,authenticated;

do $$
declare tbl text;
begin
  foreach tbl in array array['teams','groups','matches','mlp_configs','mlp_slots',
    'tournament_awards','referee_access_codes','referee_sessions','referee_score_logs',
    'team_members','group_teams','mlp_games','referee_live_actions'] loop
    execute format('drop trigger if exists competition_assign_event on public.%I',tbl);
    execute format('create trigger competition_assign_event before insert or update on public.%I
      for each row execute function public._competition_assign_event()',tbl);
  end loop;
end $$;

alter table public.tournament_events enable row level security;
revoke all on public.tournament_events from public,anon,authenticated;
grant select on public.tournament_events to anon,authenticated;
grant insert(tournament_id,name,start_time,format,expected_team_count,sort_order),
  update(name,start_time,format,expected_team_count,sort_order,status) on public.tournament_events to authenticated;
drop policy if exists competition_public_read on public.tournament_events;
create policy competition_public_read on public.tournament_events for select to anon,authenticated using(true);
drop policy if exists competition_staff_write on public.tournament_events;
create policy competition_staff_write on public.tournament_events for all to authenticated
using(auth.uid() is not null and public.is_staff())
with check(auth.uid() is not null and public.is_staff());

-- Add only restrictive write policies; retain all current staff/admin RLS and
-- public-read/player-privacy policies. Old browser writes cannot touch new events.
create or replace function public._competition_write_scope(p_event_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select case when coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-client-info' like 'pantry-event/%'
    then coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-client-info' = 'pantry-event/'||p_event_id::text
    else exists(select 1 from public.tournament_events where id=p_event_id and is_default) end;
$$;
revoke all on function public._competition_write_scope(uuid) from public,anon;
grant execute on function public._competition_write_scope(uuid) to authenticated;
do $$
declare tbl text;
begin
  foreach tbl in array array['teams','groups','matches','mlp_configs','mlp_slots',
    'tournament_awards','referee_access_codes','referee_sessions','referee_score_logs',
    'team_members','group_teams','mlp_games','referee_live_actions'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('drop policy if exists competition_insert_scope on public.%I',tbl);
    execute format('create policy competition_insert_scope on public.%I as restrictive for insert to authenticated
      with check(public._competition_write_scope(event_id))',tbl);
    execute format('drop policy if exists competition_update_scope on public.%I',tbl);
    execute format('create policy competition_update_scope on public.%I as restrictive for update to authenticated
      using(public._competition_write_scope(event_id)) with check(public._competition_write_scope(event_id))',tbl);
    execute format('drop policy if exists competition_delete_scope on public.%I',tbl);
    execute format('create policy competition_delete_scope on public.%I as restrictive for delete to authenticated
      using(public._competition_write_scope(event_id))',tbl);
  end loop;
end $$;
-- Codes have column-only grants: expose only their event ownership, never hashes.
grant select(event_id) on public.referee_access_codes to authenticated;

create or replace function public._competition_require_staff()
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.profiles
    where id=auth.uid() and public.is_staff()) then
    raise exception 'Staff permission required' using errcode='42501';
  end if;
end $$;
revoke all on function public._competition_require_staff() from public,anon,authenticated;

create or replace function public._competition_set_mlp_style(p_event_id uuid,p_style text)
returns void language plpgsql security definer set search_path='' as $$
declare tid uuid; n integer;
begin
  if p_style is null or p_style not in ('basic','mini') then raise exception 'Invalid MLP style'; end if;
  select tournament_id into tid from public.tournament_events where id=p_event_id and format='mlp' for update;
  if tid is null then raise exception 'Event is not MLP'; end if;
  if exists(select 1 from public.teams where event_id=p_event_id)
    or exists(select 1 from public.matches where event_id=p_event_id) then
    raise exception 'Cannot replace MLP style after registering teams or matches';
  end if;
  n:=case when p_style='mini' then 3 else 4 end;
  insert into public.mlp_configs(tournament_id,event_id,members_per_team,style)
    values(tid,p_event_id,n,p_style)
    on conflict(event_id) do update set members_per_team=excluded.members_per_team,style=excluded.style;
  delete from public.mlp_slots where event_id=p_event_id;
  insert into public.mlp_slots(tournament_id,event_id,slot_order,slot_name,gender,max_rating)
  select tid,p_event_id,i,
    case when p_style='mini' then 'VĐV '||i else (array['Nam 1','Nam 2','Nữ 1','Nữ 2'])[i] end,
    case when p_style='mini' then 'any' when i<=2 then 'male' else 'female' end,null
  from generate_series(1,n) i;
end $$;
revoke all on function public._competition_set_mlp_style(uuid,text) from public,anon,authenticated;

-- Keep the old signature: old callers configure the default event only.
create or replace function public.set_mlp_style(p_tournament_id uuid,p_style text)
returns void language plpgsql security definer set search_path='' as $$
declare eid uuid;
begin
  perform public._competition_require_staff();
  select id into eid from public.tournament_events where tournament_id=p_tournament_id and is_default;
  perform public._competition_set_mlp_style(eid,p_style);
end $$;
revoke all on function public.set_mlp_style(uuid,text) from public,anon;
grant execute on function public.set_mlp_style(uuid,text) to authenticated;

create or replace function public._competition_default_event()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.tournament_events(tournament_id,name,start_time,format,expected_team_count,is_default,status)
  values(new.id,'Nội dung chính',new.start_time,new.format::text,new.expected_team_count,true,coalesce(new.status::text,'draft'));
  return new;
end $$;
revoke all on function public._competition_default_event() from public,anon,authenticated;
drop trigger if exists "000_competition_default" on public.tournaments;
create trigger "000_competition_default" after insert on public.tournaments
for each row execute function public._competition_default_event();

-- Deferred initialization coexists with older AFTER INSERT tournament triggers.
-- Never reset a config/roster that an existing trigger or RPC already supplied.
create or replace function public._competition_init_mlp()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Metadata/status edits on legacy MLP events must not create or reset settings.
  if tg_op='UPDATE' and new.format is not distinct from old.format then return null; end if;
  if exists(select 1 from public.tournament_events where id=new.id and format='mlp')
    and not exists(select 1 from public.mlp_configs where event_id=new.id) then
    perform public._competition_set_mlp_style(new.id,'basic');
  end if;
  return null;
end $$;
revoke all on function public._competition_init_mlp() from public,anon,authenticated;
drop trigger if exists competition_init_mlp on public.tournament_events;
create constraint trigger competition_init_mlp after insert or update on public.tournament_events
  deferrable initially deferred for each row execute function public._competition_init_mlp();

create or replace function public._competition_guard_event()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.id<>old.id or new.tournament_id<>old.tournament_id then raise exception 'Event ownership cannot be changed'; end if;
    if new.format<>old.format then
      if exists(select 1 from public.teams where event_id=old.id)
        or exists(select 1 from public.groups where event_id=old.id)
        or exists(select 1 from public.matches where event_id=old.id)
        or exists(select 1 from public.tournament_awards where event_id=old.id) then
        raise exception 'Chỉ đổi format khi nội dung chưa có đội, bảng, trận hoặc vinh danh.';
      end if;
      delete from public.mlp_slots where event_id=old.id;
      delete from public.mlp_configs where event_id=old.id;
    end if;
    new.updated_at:=now();return new;
  end if;
  -- The parent is absent during ON DELETE CASCADE of an entire tournament.
  perform 1 from public.tournaments where id=old.tournament_id for update;
  if not found then return old; end if;
  if (select count(*) from public.tournament_events where tournament_id=old.tournament_id)<=1 then
    raise exception 'Không thể xóa nội dung cuối cùng của giải.';
  end if;
  return old;
end $$;
revoke all on function public._competition_guard_event() from public,anon,authenticated;
drop trigger if exists competition_guard_event on public.tournament_events;
create trigger competition_guard_event before update or delete on public.tournament_events
for each row execute function public._competition_guard_event();

create or replace function public._competition_promote_default()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.is_default and exists(select 1 from public.tournaments where id=old.tournament_id) then
    update public.tournament_events set is_default=true where id=(
      select id from public.tournament_events where tournament_id=old.tournament_id order by sort_order,created_at,id limit 1);
  end if;
  return null;
end $$;
revoke all on function public._competition_promote_default() from public,anon,authenticated;
drop trigger if exists competition_promote_default on public.tournament_events;
create trigger competition_promote_default after delete on public.tournament_events
for each row execute function public._competition_promote_default();

create or replace function public.save_competition_event(
  p_tournament_id uuid,p_event_id uuid,p_name text,p_start_time time,
  p_format text,p_expected_team_count integer,p_style text default 'basic')
returns uuid language plpgsql security definer set search_path='' as $$
declare eid uuid; old_format text;
begin
  perform public._competition_require_staff();
  perform 1 from public.tournaments where id=p_tournament_id for update;
  if not found then raise exception 'Tournament not found'; end if;
  if p_event_id is null then
    insert into public.tournament_events(tournament_id,name,start_time,format,expected_team_count,sort_order)
    values(p_tournament_id,btrim(p_name),p_start_time,p_format,p_expected_team_count,
      (select coalesce(max(sort_order),-1)+1 from public.tournament_events where tournament_id=p_tournament_id)) returning id into eid;
  else
    select format into old_format from public.tournament_events where id=p_event_id and tournament_id=p_tournament_id for update;
    if not found then raise exception 'Event not found'; end if;
    update public.tournament_events set name=btrim(p_name),start_time=p_start_time,
      format=p_format,expected_team_count=p_expected_team_count where id=p_event_id;
    eid:=p_event_id;
  end if;
  if p_format='mlp' and (p_event_id is null or old_format<>'mlp') then
    perform public._competition_set_mlp_style(eid,p_style);
  end if;
  return eid;
end $$;
revoke all on function public.save_competition_event(uuid,uuid,text,time,text,integer,text) from public,anon;
grant execute on function public.save_competition_event(uuid,uuid,text,time,text,integer,text) to authenticated;

create or replace function public.delete_competition_event(p_event_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare tid uuid; tbl text; populated boolean;
begin
  perform public._competition_require_staff();
  select tournament_id into tid from public.tournament_events where id=p_event_id;
  if tid is null then raise exception 'Event not found'; end if;
  perform 1 from public.tournaments where id=tid for update;
  perform 1 from public.tournament_events where id=p_event_id for update;
  if not found then raise exception 'Event not found'; end if;
  if (select count(*) from public.tournament_events where tournament_id=tid)<=1 then
    raise exception 'Không thể xóa nội dung cuối cùng của giải.';
  end if;
  foreach tbl in array array['teams','groups','matches','tournament_awards',
    'referee_access_codes','referee_sessions','referee_score_logs'] loop
    execute format('select exists(select 1 from public.%I where event_id=$1)',tbl) into populated using p_event_id;
    if populated then raise exception 'Nội dung đã có dữ liệu thi đấu. Không xóa để bảo toàn dữ liệu.'; end if;
  end loop;
  delete from public.mlp_slots where event_id=p_event_id;
  delete from public.mlp_configs where event_id=p_event_id;
  delete from public.tournament_events where id=p_event_id;
end $$;
revoke all on function public.delete_competition_event(uuid) from public,anon;
grant execute on function public.delete_competition_event(uuid) to authenticated;

-- Keep the legacy courts column for existing data/clients. Supply a default
-- only if the original schema had none; it is no longer a planning-form field.
do $$
begin
  if exists(select 1 from pg_attribute a where a.attrelid='public.tournaments'::regclass
    and a.attname='number_of_courts' and not a.attisdropped and not a.atthasdef) then
    alter table public.tournaments alter column number_of_courts set default 6;
  end if;
end $$;

-- Tournament, default event, and chosen MLP style commit atomically. Invoker
-- security preserves the existing tournament INSERT RLS authorization.
create or replace function public.create_competition_tournament(
  p_name text,p_event_type text,p_start_date date,p_start_time time,p_format text,
  p_expected_team_count integer,p_style text default 'basic')
returns uuid language plpgsql security invoker set search_path='' as $$
declare row_data public.tournaments%rowtype; tid uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if nullif(btrim(p_name),'') is null then raise exception 'Tournament name required'; end if;
  -- Populate through the real table type (also works with enum base columns).
  row_data:=jsonb_populate_record(null::public.tournaments,jsonb_build_object(
    'name',btrim(p_name),'event_type',p_event_type,'start_date',p_start_date,
    'start_time',p_start_time,'format',p_format,'expected_team_count',p_expected_team_count,
    'created_by',auth.uid()));
  insert into public.tournaments(name,event_type,start_date,start_time,format,expected_team_count,created_by)
    values(row_data.name,row_data.event_type,row_data.start_date,row_data.start_time,
      row_data.format,row_data.expected_team_count,row_data.created_by) returning id into tid;
  if p_format='mlp' then perform public.set_mlp_style(tid,p_style); end if;
  return tid;
end $$;
revoke all on function public.create_competition_tournament(text,text,date,time,text,integer,text) from public,anon;
grant execute on function public.create_competition_tournament(text,text,date,time,text,integer,text) to authenticated;

-- Same privacy boundary as public_tournament_roster: only display names/counts.
create or replace function public.public_event_roster(p_event_id uuid)
returns table(team_id uuid,player_names text[],registered_players bigint)
language sql stable security definer set search_path='' as $$
  select t.id,coalesce(array_agg(p.full_name::text order by tm.slot_order)
    filter(where p.id is not null),array[]::text[]),
    (select count(distinct tm2.player_id) from public.teams t2
     join public.team_members tm2 on tm2.team_id=t2.id where t2.event_id=p_event_id)
  from public.teams t left join public.team_members tm on tm.team_id=t.id
  left join public.players p on p.id=tm.player_id where t.event_id=p_event_id group by t.id;
$$;
revoke all on function public.public_event_roster(uuid) from public;
grant execute on function public.public_event_roster(uuid) to anon,authenticated;

-- Admin code visibility stays admin-only and returns this event's groups only.
create or replace function public.admin_event_referee_codes(p_event_id uuid)
returns table(group_id uuid,readable_code text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.profiles
    where id=auth.uid() and lower(role::text)='admin') then
    raise exception 'Admin permission required' using errcode='42501';
  end if;
  return query select c.group_id,c.readable_code from public.referee_access_codes c
    where c.event_id=p_event_id and c.active
      and (c.expires_at is null or c.expires_at>now());
end $$;
revoke all on function public.admin_event_referee_codes(uuid) from public,anon;
grant execute on function public.admin_event_referee_codes(uuid) to authenticated;

-- Keep the dashboard status behavior of a single-event tournament.
create or replace function public._competition_sync_single_status()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_default and new.status is distinct from old.status
    and (select count(*) from public.tournament_events where tournament_id=new.tournament_id)=1 then
    update public.tournaments set status=(jsonb_populate_record(null::public.tournaments,jsonb_build_object('status',new.status))).status where id=new.tournament_id;
  end if;
  return null;
end $$;
revoke all on function public._competition_sync_single_status() from public,anon,authenticated;
drop trigger if exists competition_sync_single_status on public.tournament_events;
create trigger competition_sync_single_status after update on public.tournament_events
for each row execute function public._competition_sync_single_status();

-- Existing referee algorithms and token/code validation are retained below.
-- Only ownership checks, event format lookups and snapshot context change.

create or replace function public._referee_event_live_allowed(p_event_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.tournament_events e where e.id=p_event_id and e.format='doubles')
    or exists(select 1 from public.tournament_events e join public.mlp_configs c on c.event_id=e.id
      where e.id=p_event_id and e.format='mlp' and (c.style='mini' or c.members_per_team=3
      or (select count(*) from public.mlp_slots s where s.event_id=e.id)=3));
$$;
revoke all on function public._referee_event_live_allowed(uuid) from public,anon,authenticated;

create or replace function public._referee_live_allowed(p_tournament_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public._referee_event_live_allowed(id) from public.tournament_events
  where tournament_id=p_tournament_id and is_default;
$$;
revoke all on function public._referee_live_allowed(uuid) from public,anon,authenticated;

create or replace function public.get_referee_session(p_session_token uuid)
returns table (
  session_token uuid, tournament_id uuid, group_id uuid,
  group_name text, referee_name text, expires_at timestamptz
)
language sql stable security definer
set search_path = public as $$
  select s.id, s.tournament_id, s.group_id, g.name, s.referee_name, s.expires_at
  from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  join public.groups g on g.id = s.group_id and g.tournament_id = s.tournament_id and g.event_id = s.event_id
  where s.id = p_session_token and s.active = true and s.expires_at > now()
    and c.active = true and (c.expires_at is null or c.expires_at > now());
$$;

create or replace function public._referee_live_snapshot(p_match_id uuid)
returns jsonb language sql stable security definer
set search_path = public as $$
  select jsonb_build_object(
    'event_id', m.event_id, 'event_name', e.name, 'tournament_name', t.name,
    'match_id', m.id, 'match_code', m.match_code, 'group_name', g.name,
    'team1_name', a.name, 'team2_name', b.name,
    'team1_score', coalesce(m.team1_score, 0),
    'team2_score', coalesce(m.team2_score, 0),
    'score_target', m.score_target, 'win_by_two', m.win_by_two,
    'version', m.score_version, 'status', m.status,
    'started_at', m.started_at,
    'can_finish', greatest(coalesce(m.team1_score,0), coalesce(m.team2_score,0)) >= m.score_target
      and abs(coalesce(m.team1_score,0) - coalesce(m.team2_score,0)) >=
          case when m.win_by_two then 2 else 1 end,
    'winner_name', case when coalesce(m.team1_score,0) > coalesce(m.team2_score,0)
                        then a.name else b.name end
  )
  from public.matches m
  join public.tournament_events e on e.id=m.event_id
  join public.tournaments t on t.id=m.tournament_id
  join public.groups g on g.id = m.group_id and g.tournament_id = m.tournament_id and g.event_id = m.event_id
  join public.teams a on a.id = m.team1_id and a.tournament_id = m.tournament_id and a.event_id = m.event_id
  join public.teams b on b.id = m.team2_id and b.tournament_id = m.tournament_id and b.event_id = m.event_id
  where m.id = p_match_id;
$$;

create or replace function public.referee_live_state(p_session_token uuid)
returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare v_session public.referee_sessions%rowtype; v_match_id uuid;
begin
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.id into v_match_id from public.matches m
  where m.status = 'playing' and m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id
    and m.group_id = v_session.group_id
    and m.stage = 'group' and public._referee_event_live_allowed(m.event_id) limit 1;
  if v_match_id is null then return null; end if;
  return public._referee_live_snapshot(v_match_id);
end;
$$;

create or replace function public.referee_live_start(
  p_session_token uuid, p_match_id uuid,
  p_score_target integer, p_win_by_two boolean
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_group_name text;
begin
  if p_score_target is null or p_score_target < 1 or p_score_target > 999 or p_win_by_two is null then
    raise exception 'Đích điểm phải là số nguyên từ 1 đến 999.';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  -- Serialize starts in the group, including starts from different devices.
  perform pg_advisory_xact_lock(hashtextextended(v_session.group_id::text, 71513));
  if not exists (
    select 1 from public.referee_sessions s
    join public.referee_access_codes c on c.id = s.access_code_id
      and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
    where s.id = v_session.id and s.active and s.expires_at > now()
      and c.active and (c.expires_at is null or c.expires_at > now())
  ) then raise exception 'Referee access expired or revoked'; end if;
  if exists (select 1 from public.matches m
             where m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id and m.group_id = v_session.group_id
               and m.stage = 'group' and m.status = 'playing' and m.id <> p_match_id) then
    raise exception 'Finish the active match before starting another';
  end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
  if not public._referee_event_live_allowed(v_match.event_id) then
    raise exception 'Scorekeeper is only for Doubles and MLP Mini';
  end if;
  if v_match.status = 'completed' then raise exception 'This match is already completed'; end if;
  if v_match.status = 'playing' then
    return public._referee_live_snapshot(v_match.id);
  end if;
  if v_match.status = 'scheduled' then
    if coalesce(v_match.team1_score,0) < 0 or coalesce(v_match.team2_score,0) < 0 then
      raise exception 'Existing score cannot be negative';
    end if;
    update public.matches set status = 'playing', started_at = now(),
      team1_score = coalesce(team1_score,0), team2_score = coalesce(team2_score,0),
      score_target = p_score_target, win_by_two = p_win_by_two,
      winner_id = null, completed_at = null, score_version = score_version + 1
    where id = v_match.id;
  else
    raise exception 'This match cannot be started';
  end if;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code,
     referee_name, action, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name, 'live_start',
          v_match.team1_score, v_match.team2_score,
          coalesce(v_match.team1_score,0), coalesce(v_match.team2_score,0));
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
  return public._referee_live_snapshot(v_match.id);
end;
$$;

create or replace function public.referee_live_adjust(
  p_session_token uuid, p_match_id uuid, p_team integer, p_delta integer,
  p_expected_version bigint, p_expected_team1_score integer,
  p_expected_team2_score integer, p_action_id uuid
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_action public.referee_live_actions%rowtype;
  v_inserted uuid;
  v_new1 integer;
  v_new2 integer;
  v_group_name text;
begin
  if p_team not in (1,2) or p_team is null or p_delta not in (-1,1)
     or p_delta is null or p_action_id is null or p_expected_version is null
     or p_expected_team1_score is null or p_expected_team2_score is null then
    raise exception 'Invalid score action';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id
    and m.group_id = v_session.group_id and m.stage = 'group'
    and m.status = 'playing'
  for update;
  if v_match.id is null then raise exception 'No active match assigned to this referee'; end if;
  if not public._referee_event_live_allowed(v_match.event_id) then
    raise exception 'Scorekeeper is only for Doubles and MLP Mini';
  end if;
  select * into v_action from public.referee_live_actions where id = p_action_id;
  if v_action.id is not null then
    if v_action.referee_session_id <> v_session.id or v_action.match_id <> v_match.id then
      raise exception 'Action ID belongs to another match';
    end if;
    return public._referee_live_snapshot(v_match.id);
  end if;
  if v_match.score_version is distinct from p_expected_version
     or coalesce(v_match.team1_score,0) is distinct from p_expected_team1_score
     or coalesce(v_match.team2_score,0) is distinct from p_expected_team2_score then
    return public._referee_live_snapshot(v_match.id) || jsonb_build_object('stale',true);
  end if;
  v_new1 := coalesce(v_match.team1_score,0) + case when p_team = 1 then p_delta else 0 end;
  v_new2 := coalesce(v_match.team2_score,0) + case when p_team = 2 then p_delta else 0 end;
  if v_new1 < 0 or v_new2 < 0 then raise exception 'Score cannot be negative'; end if;
  insert into public.referee_live_actions(id, referee_session_id, match_id)
  values (p_action_id, v_session.id, v_match.id)
  on conflict (id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_action from public.referee_live_actions where id = p_action_id;
    if v_action.referee_session_id <> v_session.id or v_action.match_id <> v_match.id then
      raise exception 'Action ID belongs to another match';
    end if;
    return public._referee_live_snapshot(v_match.id);
  end if;
  update public.matches set team1_score = v_new1, team2_score = v_new2,
    score_version = score_version + 1 where id = v_match.id;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code,
     referee_name, action, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name,
          case when p_delta = 1 then 'live_plus' else 'live_minus' end,
          v_match.team1_score, v_match.team2_score, v_new1, v_new2);
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
  return public._referee_live_snapshot(v_match.id);
end;
$$;

create or replace function public.referee_live_finish(
  p_session_token uuid, p_match_id uuid, p_expected_version bigint,
  p_expected_team1_score integer, p_expected_team2_score integer
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_winner uuid;
  v_group_name text;
begin
  if p_expected_version is null or p_expected_team1_score is null
     or p_expected_team2_score is null then raise exception 'Missing score state'; end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id
    and m.group_id = v_session.group_id and m.stage = 'group'
    and m.status = 'playing'
  for update;
  if v_match.id is null then raise exception 'No active match assigned to this referee'; end if;
  if not public._referee_event_live_allowed(v_match.event_id) then
    raise exception 'Scorekeeper is only for Doubles and MLP Mini';
  end if;
  if v_match.score_version is distinct from p_expected_version
     or coalesce(v_match.team1_score,0) is distinct from p_expected_team1_score
     or coalesce(v_match.team2_score,0) is distinct from p_expected_team2_score then
    return public._referee_live_snapshot(v_match.id) || jsonb_build_object('stale',true);
  end if;
  if greatest(coalesce(v_match.team1_score,0),coalesce(v_match.team2_score,0)) < v_match.score_target
     or abs(coalesce(v_match.team1_score,0)-coalesce(v_match.team2_score,0)) <
        (case when v_match.win_by_two then 2 else 1 end) then
    raise exception 'Score does not satisfy the finishing rule';
  end if;
  v_winner := case when v_match.team1_score > v_match.team2_score
                   then v_match.team1_id else v_match.team2_id end;
  update public.matches set status = 'completed', winner_id = v_winner,
    completed_at = now(), team1_score = v_match.team1_score,
    team2_score = v_match.team2_score, score_version = score_version + 1
  where id = v_match.id;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code,
     referee_name, action, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name, 'live_finish',
          v_match.team1_score, v_match.team2_score,
          v_match.team1_score, v_match.team2_score);
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
  return public._referee_live_snapshot(v_match.id);
end;
$$;

create or replace function public.referee_submit_score(
  p_session_token uuid, p_match_id uuid,
  p_team1_score integer, p_team2_score integer
)
returns void language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_format text;
  v_winner uuid;
  v_group_name text;
begin
  if p_team1_score is null or p_team2_score is null or
     p_team1_score < 0 or p_team2_score < 0 or p_team1_score = p_team2_score then
    raise exception 'Invalid score';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  where s.id = p_session_token and s.active and s.expires_at > now()
    and c.active and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
  if v_match.status <> 'completed' then
    raise exception 'Use Scorekeeper Mode to start and finish this match';
  end if;
  select t.format into v_format from public.tournament_events t where t.id = v_match.event_id;
  if not coalesce(v_format = 'doubles' or (
    v_format = 'mlp' and exists (
      select 1 from public.mlp_configs c where c.event_id = v_match.event_id
        and (c.style = 'mini' or c.members_per_team = 3 or
             (select count(*) from public.mlp_slots x where x.event_id = c.event_id) = 3)
    )
  ), false) then raise exception 'Aggregate scoring is only allowed for Doubles and MLP Mini'; end if;
  v_winner := case when p_team1_score > p_team2_score then v_match.team1_id
                   else v_match.team2_id end;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code, referee_name,
     action, old_team1_score, old_team2_score, new_team1_score, new_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          v_match.id, v_match.match_code, v_session.referee_name, 'edit_score',
          v_match.team1_score, v_match.team2_score, p_team1_score, p_team2_score);
  update public.matches set team1_score = p_team1_score, team2_score = p_team2_score,
    winner_id = v_winner, completed_at = coalesce(completed_at, now()),
    score_version = score_version + 1
  where id = v_match.id;
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
end;
$$;

create or replace function public.referee_submit_mlp_game(
  p_session_token uuid, p_match_id uuid, p_game_order integer,
  p_game_type text, p_team1_score integer, p_team2_score integer
)
returns void language plpgsql security definer
set search_path = public as $$
declare
  v_session public.referee_sessions%rowtype;
  v_match public.matches%rowtype;
  v_old_game public.mlp_games%rowtype;
  v_stale_game public.mlp_games%rowtype;
  v_expected_type text;
  v_game_winner uuid;
  v_a4 integer;
  v_b4 integer;
  v_count4 integer;
  v_w1 integer;
  v_w2 integer;
  v_db_winner uuid;
  v_completed boolean := false;
  v_match_winner uuid;
  v_group_name text;
begin
  v_expected_type := case p_game_order
    when 1 then 'women_doubles' when 2 then 'men_doubles'
    when 3 then 'mixed_1' when 4 then 'mixed_2'
    when 5 then 'dreambreaker' else null end;
  if v_expected_type is null or p_game_type is distinct from v_expected_type then
    raise exception 'Invalid MLP game order or type';
  end if;
  if p_team1_score is null or p_team2_score is null or
     p_team1_score < 0 or p_team2_score < 0 or p_team1_score = p_team2_score then
    raise exception 'Invalid score';
  end if;
  select s.* into v_session from public.referee_sessions s
  join public.referee_access_codes c on c.id = s.access_code_id
    and c.tournament_id = s.tournament_id and c.group_id = s.group_id and c.event_id = s.event_id
  where s.id = p_session_token and s.active = true and s.expires_at > now()
    and c.active = true and (c.expires_at is null or c.expires_at > now());
  if v_session.id is null then raise exception 'Referee access expired or revoked'; end if;
  select m.* into v_match from public.matches m
  where m.id = p_match_id and m.tournament_id = v_session.tournament_id and m.event_id = v_session.event_id
    and m.group_id = v_session.group_id and m.stage = 'group'
  for update;
  if v_match.id is null then raise exception 'You do not have permission for this match'; end if;
  select g.name into v_group_name from public.groups g where g.id = v_session.group_id;
  if not exists (
    select 1 from public.tournament_events t
    join public.mlp_configs c on c.event_id = t.id
    where t.id = v_match.event_id and t.format = 'mlp'
      and c.style = 'basic' and c.members_per_team <> 3
      and (select count(*) from public.mlp_slots x where x.event_id = t.id) <> 3
  ) then raise exception 'Game scoring is only allowed for MLP Basic'; end if;
  select count(*),
         count(*) filter (where winner_team_id = v_match.team1_id),
         count(*) filter (where winner_team_id = v_match.team2_id)
  into v_count4, v_a4, v_b4 from public.mlp_games
  where match_id = p_match_id and game_order between 1 and 4;
  if p_game_order = 5 and not (v_count4 = 4 and v_a4 = 2 and v_b4 = 2) then
    raise exception 'DreamBreaker requires a 2-2 tie after games 1-4';
  end if;
  select * into v_old_game from public.mlp_games
  where match_id = p_match_id and game_order = p_game_order;
  v_game_winner := case when p_team1_score > p_team2_score then v_match.team1_id
                        else v_match.team2_id end;
  if v_old_game.id is null then
    insert into public.mlp_games
      (match_id, game_order, game_type, team1_score, team2_score, winner_team_id)
    values (p_match_id, p_game_order, v_expected_type,
            p_team1_score, p_team2_score, v_game_winner);
  else
    update public.mlp_games set game_type = v_expected_type,
      team1_score = p_team1_score, team2_score = p_team2_score,
      winner_team_id = v_game_winner where id = v_old_game.id;
  end if;
  select count(*),
         count(*) filter (where winner_team_id = v_match.team1_id),
         count(*) filter (where winner_team_id = v_match.team2_id)
  into v_count4, v_a4, v_b4 from public.mlp_games
  where match_id = p_match_id and game_order between 1 and 4;
  if v_count4 <> 4 or v_a4 <> 2 or v_b4 <> 2 then
    select * into v_stale_game from public.mlp_games
    where match_id = p_match_id and game_order = 5;
    if v_stale_game.id is not null then
      delete from public.mlp_games where id = v_stale_game.id;
      insert into public.referee_score_logs
        (referee_session_id, tournament_id, group_id, group_name, match_id, match_code, referee_name,
         action, game_order, game_type, old_game_team1_score, old_game_team2_score)
      values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
              p_match_id, v_match.match_code,
              v_session.referee_name, 'mlp_game_invalidated', 5, 'dreambreaker',
              v_stale_game.team1_score, v_stale_game.team2_score);
    end if;
  end if;
  v_w1 := v_a4; v_w2 := v_b4;
  if v_count4 = 4 then
    if v_a4 <> v_b4 then
      v_completed := true;
      v_match_winner := case when v_a4 > v_b4 then v_match.team1_id else v_match.team2_id end;
    else
      select winner_team_id into v_db_winner from public.mlp_games
      where match_id = p_match_id and game_order = 5;
      if v_db_winner is not null then
        v_completed := true; v_match_winner := v_db_winner;
        v_w1 := v_a4 + case when v_db_winner = v_match.team1_id then 1 else 0 end;
        v_w2 := v_b4 + case when v_db_winner = v_match.team2_id then 1 else 0 end;
      end if;
    end if;
  end if;
  update public.matches set team1_score = v_w1, team2_score = v_w2,
    winner_id = case when v_completed then v_match_winner else null end,
    status = case when v_completed then 'completed' else 'scheduled' end,
    completed_at = case when v_completed then now() else null end
  where id = p_match_id;
  insert into public.referee_score_logs
    (referee_session_id, tournament_id, group_id, group_name, match_id, match_code, referee_name,
     action, game_order, game_type, old_team1_score, old_team2_score,
     new_team1_score, new_team2_score, old_game_team1_score,
     old_game_team2_score, new_game_team1_score, new_game_team2_score)
  values (v_session.id, v_session.tournament_id, v_session.group_id, v_group_name,
          p_match_id, v_match.match_code,
          v_session.referee_name,
          case when v_old_game.id is null then 'submit_mlp_game' else 'edit_mlp_game' end,
          p_game_order, v_expected_type, v_match.team1_score, v_match.team2_score,
          v_w1, v_w2, v_old_game.team1_score, v_old_game.team2_score,
          p_team1_score, p_team2_score);
  update public.referee_sessions set last_used_at = now() where id = v_session.id;
end;
$$;

revoke all on function public._referee_live_snapshot(uuid) from public,anon,authenticated;

-- Explicit ACLs also make the intended security boundary reviewable.
revoke all on function public.get_referee_session(uuid),
  public.referee_live_state(uuid),public.referee_live_start(uuid,uuid,integer,boolean),
  public.referee_live_adjust(uuid,uuid,integer,integer,bigint,integer,integer,uuid),
  public.referee_live_finish(uuid,uuid,bigint,integer,integer),
  public.referee_submit_score(uuid,uuid,integer,integer),
  public.referee_submit_mlp_game(uuid,uuid,integer,text,integer,integer) from public;
grant execute on function public.get_referee_session(uuid),
  public.referee_live_state(uuid),public.referee_live_start(uuid,uuid,integer,boolean),
  public.referee_live_adjust(uuid,uuid,integer,integer,bigint,integer,integer,uuid),
  public.referee_live_finish(uuid,uuid,bigint,integer,integer),
  public.referee_submit_score(uuid,uuid,integer,integer),
  public.referee_submit_mlp_game(uuid,uuid,integer,text,integer,integer) to anon,authenticated;

set constraints all immediate;
do $$
declare r record; n bigint; changed boolean;
begin
  for r in select * from pantry_event_migration_counts loop
    execute format('select count(*) from public.%I',r.table_name) into n;
    if n<>r.row_count then raise exception 'Row count changed for %; migration rolled back',r.table_name; end if;
    -- EXCEPT ALL compares the complete multiset, including duplicate legacy rows.
    execute format('with current_rows as (
      select (select jsonb_object_agg(k,v) from jsonb_each(to_jsonb(t)) j(k,v)
              where k=any($2)) row_data from public.%I t
    ), prior_rows as (select row_data from pantry_event_migration_rows where table_name=$1)
    select exists(
      (select row_data from current_rows except all select row_data from prior_rows)
      union all
      (select row_data from prior_rows except all select row_data from current_rows)
    )',r.table_name) into changed using r.table_name,r.preserved_columns;
    if changed then raise exception 'Existing data changed in %; migration rolled back',r.table_name; end if;
  end loop;
  if exists(select 1 from public.tournaments t where
    (select count(*) from public.tournament_events e where e.tournament_id=t.id and e.is_default)<>1) then
    raise exception 'Every tournament must have exactly one default event';
  end if;
end $$;

-- Schema cache reload only when this transaction is manually executed.
notify pgrst, 'reload schema';
commit;

/*
PREFLIGHT Q1 BEGIN — COPY ONLY THE READ-ONLY QUERY BELOW; DO NOT RUN THE MIGRATION YET.
-- Q1: Schema, dependencies, RPC definitions and privacy. READ ONLY.
-- Send the result for review; absence of the original base schema prevents
-- certifying these details from the repository alone. No athlete data is returned.
with wanted(name) as (
  values ('tournaments'),('tournament_events'),('teams'),('team_members'),
    ('groups'),('group_teams'),('matches'),('mlp_configs'),('mlp_slots'),('mlp_games'),
    ('referee_access_codes'),('referee_sessions'),('referee_score_logs'),('referee_live_actions'),
    ('tournament_awards'),('players'),('player_flags'),('profiles'),
    ('tournament_info'),('tournament_followers'),('tournament_deletion_audit')
), objects as (
  select w.name,c.oid,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    pg_get_userbyid(c.relowner) owner,
    case when c.oid is not null then pg_has_role(current_user,c.relowner,'USAGE') end role_has_owner_privileges,
    c.reltuples approximate_rows,
    case when c.relkind in ('r','p') then pg_total_relation_size(c.oid) end total_bytes
  from wanted w left join pg_class c on c.oid=to_regclass(format('public.%I',w.name))
), report as (
  select '00_execution_context' section,jsonb_build_object(
    'current_user',current_user,'server_version',current_setting('server_version'),
    'public_schema_create',has_schema_privilege(current_user,'public','CREATE'),
    'database_temp',has_database_privilege(current_database(),'TEMP'),
    'lock_timeout',current_setting('lock_timeout'),'statement_timeout',current_setting('statement_timeout')
  ) details
  union all
  select '01_tables',coalesce(jsonb_agg(to_jsonb(o) order by o.name),'[]') from objects o
  union all
  select '02_columns',coalesce(jsonb_agg(jsonb_build_object(
    'table',o.name,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),
    'identity',a.attidentity,'generated',a.attgenerated,
    'anon_select',has_column_privilege('anon',a.attrelid,a.attnum,'SELECT'),
    'authenticated_select',has_column_privilege('authenticated',a.attrelid,a.attnum,'SELECT')
  ) order by o.name,a.attnum),'[]')
  from objects o join pg_attribute a on a.attrelid=o.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  union all
  select '03_constraints_including_incoming_fks',coalesce(jsonb_agg(jsonb_build_object(
    'table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid),
    'validated',c.convalidated,'referenced_table',nullif(c.confrelid,0)::regclass::text,
    'referenced_unique_index',nullif(c.conindid,0)::regclass::text
  ) order by c.conrelid::regclass::text,c.conname),'[]')
  from pg_constraint c where c.conrelid in(select oid from objects) or c.confrelid in(select oid from objects)
  union all
  select '04_indexes',coalesce(jsonb_agg(jsonb_build_object(
    'table',i.indrelid::regclass::text,'definition',pg_get_indexdef(i.indexrelid),
    'valid',i.indisvalid,'unique',i.indisunique,'primary',i.indisprimary
  ) order by i.indrelid::regclass::text,i.indexrelid),'[]')
  from pg_index i where i.indrelid in(select oid from objects)
  union all
  select '05_user_triggers',coalesce(jsonb_agg(jsonb_build_object(
    'table',t.tgrelid::regclass::text,'name',t.tgname,'enabled',t.tgenabled,
    'trigger',pg_get_triggerdef(t.oid),'function',pg_get_functiondef(t.tgfoid)
  ) order by t.tgrelid::regclass::text,t.tgname),'[]')
  from pg_trigger t where t.tgrelid in(select oid from objects) and not t.tgisinternal
  union all
  select '06_rls_policies',coalesce(jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname),'[]')
  from pg_policies p where p.schemaname='public' and p.tablename in(select name from wanted)
  union all
  select '07_relevant_rpcs',coalesce(jsonb_agg(jsonb_build_object(
    'signature',p.oid::regprocedure::text,'result',pg_get_function_result(p.oid),
    'security_definer',p.prosecdef,'owner',pg_get_userbyid(p.proowner),
    'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
    'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
    'definition',pg_get_functiondef(p.oid)
  ) order by p.oid::regprocedure::text),'[]')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f' and (
    p.proname='is_staff' or p.proname like '%referee%' or p.proname like '%competition%'
    or p.prosrc ~ '(tournaments|teams|team_members|groups|matches|mlp_|tournament_awards|players|player_flags)')
  union all
  select '08_other_tournament_owned_tables',coalesce(jsonb_agg(jsonb_build_object(
    'table',c.oid::regclass::text,'column',a.attname
  ) order by c.oid::regclass::text),'[]')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attname='tournament_id' and not a.attisdropped
  where n.nspname='public' and c.relkind in ('r','p') and c.relname not in(select name from wanted)
  union all
  select '09_views_referencing_players',coalesce(jsonb_agg(jsonb_build_object(
    'view',c.oid::regclass::text,'anon_select',has_table_privilege('anon',c.oid,'SELECT'),
    'definition',pg_get_viewdef(c.oid,true)
  ) order by c.oid::regclass::text),'[]')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('v','m')
    and pg_get_viewdef(c.oid,true) ~ '(players|player_flags)'
)
select section,details from report order by section;
PREFLIGHT Q1 END
*/

/*
PREFLIGHT Q2 BEGIN — COPY ONLY THE READ-ONLY QUERY BELOW.
-- Q2: Legacy data integrity / new-constraint prerequisites. READ ONLY.
-- Run only after Q1 confirms the referenced tables/columns exist.
-- Every returned violations value must be 0 for a FIRST application.
with records(table_name,row_data,tournament_id) as (
  select 'teams',to_jsonb(r),r.tournament_id from public.teams r
  union all select 'groups',to_jsonb(r),r.tournament_id from public.groups r
  union all select 'matches',to_jsonb(r),r.tournament_id from public.matches r
  union all select 'mlp_configs',to_jsonb(r),r.tournament_id from public.mlp_configs r
  union all select 'mlp_slots',to_jsonb(r),r.tournament_id from public.mlp_slots r
  union all select 'tournament_awards',to_jsonb(r),r.tournament_id from public.tournament_awards r
  union all select 'referee_access_codes',to_jsonb(r),r.tournament_id from public.referee_access_codes r
  union all select 'referee_sessions',to_jsonb(r),r.tournament_id from public.referee_sessions r
  union all select 'referee_score_logs',to_jsonb(r),r.tournament_id from public.referee_score_logs r
  union all select 'team_members',to_jsonb(r),p.tournament_id from public.team_members r left join public.teams p on p.id=r.team_id
  union all select 'group_teams',to_jsonb(r),p.tournament_id from public.group_teams r left join public.groups p on p.id=r.group_id
  union all select 'mlp_games',to_jsonb(r),p.tournament_id from public.mlp_games r left join public.matches p on p.id=r.match_id
  union all select 'referee_live_actions',to_jsonb(r),p.tournament_id from public.referee_live_actions r left join public.matches p on p.id=r.match_id
), edges(child_table,child_column,parent_table,required) as (
  values ('team_members','team_id','teams',true),
    ('group_teams','group_id','groups',true),('group_teams','team_id','teams',true),
    ('matches','group_id','groups',false),('matches','team1_id','teams',false),
    ('matches','team2_id','teams',false),('matches','winner_id','teams',false),
    ('mlp_games','match_id','matches',true),('mlp_games','winner_team_id','teams',false),
    ('tournament_awards','team_id','teams',false),('referee_access_codes','group_id','groups',true),
    ('referee_sessions','group_id','groups',true),('referee_sessions','access_code_id','referee_access_codes',true),
    ('referee_score_logs','group_id','groups',false),('referee_score_logs','match_id','matches',false),
    ('referee_score_logs','referee_session_id','referee_sessions',false),
    ('referee_live_actions','match_id','matches',true),('referee_live_actions','referee_session_id','referee_sessions',true)
), checks(check_name,violations) as (
  select 'orphan_or_missing_tournament',count(*) from records r
    where not exists(select 1 from public.tournaments t where t.id=r.tournament_id)
  union all
  select 'redundant_tournament_id_mismatch',count(*) from records r
    where r.row_data->>'tournament_id' is not null
      and (r.row_data->>'tournament_id') is distinct from r.tournament_id::text
  union all
  select e.child_table||'.'||e.child_column||'_missing_or_cross_tournament',
    count(*) filter(where c.row_data is not null and ((e.required and c.row_data->>e.child_column is null)
      or (c.row_data->>e.child_column is not null
        and (p.row_data is null or p.tournament_id is distinct from c.tournament_id))))
  from edges e left join records c on c.table_name=e.child_table
  left join records p on p.table_name=e.parent_table and p.row_data->>'id'=c.row_data->>e.child_column
  group by e.child_table,e.child_column
  union all
  select 'unsupported_tournament_format',count(*) from public.tournaments
    where format is null or format::text not in ('doubles','mlp')
  union all
  select 'invalid_existing_planned_count',count(*) from public.tournaments t
    where to_jsonb(t)->'expected_team_count' is not null
      and to_jsonb(t)->'expected_team_count'<>'null'::jsonb
      and case when jsonb_typeof(to_jsonb(t)->'expected_team_count')='number'
        then (to_jsonb(t)->>'expected_team_count')::numeric<=0
          or (to_jsonb(t)->>'expected_team_count')::numeric>2147483647
          or (to_jsonb(t)->>'expected_team_count')::numeric<>trunc((to_jsonb(t)->>'expected_team_count')::numeric)
        else true end
  union all
  select 'duplicate_mlp_configs',count(*) from (
    select tournament_id from public.mlp_configs group by tournament_id having count(*)>1
  ) d
  union all
  select 'duplicate_mlp_slots',count(*) from (
    select tournament_id,slot_order from public.mlp_slots where slot_order is not null
    group by tournament_id,slot_order having count(*)>1
  ) d
  union all
  select 'duplicate_award_positions',count(*) from (
    select tournament_id,placement,placement_slot from public.tournament_awards
    where placement is not null and placement_slot is not null
    group by tournament_id,placement,placement_slot having count(*)>1
  ) d
  union all
  select 'duplicate_referee_group_codes',count(*) from (
    select tournament_id,group_id from public.referee_access_codes
    group by tournament_id,group_id having count(*)>1
  ) d
  union all
  select 'session_code_group_mismatch',count(*) from public.referee_sessions s
    join public.referee_access_codes c on c.id=s.access_code_id
    where s.group_id is distinct from c.group_id or s.tournament_id is distinct from c.tournament_id
  union all
  select 'preexisting_event_ownership_requires_review',count(*) from records
    where row_data->>'event_id' is not null
  union all
  select 'anonymous_player_column_access',count(*) from pg_attribute a
    where a.attrelid='public.players'::regclass and a.attnum>0 and not a.attisdropped
      and has_column_privilege('anon',a.attrelid,a.attnum,'SELECT')
)
select check_name,violations from checks order by check_name;
PREFLIGHT Q2 END
*/
