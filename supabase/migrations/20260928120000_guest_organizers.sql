-- Run manually in Supabase SQL Editor after the existing event/knockout migrations.
-- No existing tournament ownership is backfilled. No tournament data is deleted.
-- Enum extension must commit before the new value can be used.
begin;
do $$
declare typ regtype;
begin
  select a.atttypid::regtype into typ from pg_attribute a join pg_type t on t.oid=a.atttypid
    where a.attrelid='public.profiles'::regclass and a.attname='role' and t.typtype='e';
  if typ is not null then execute format('alter type %s add value if not exists %L',typ,'organizer'); end if;
end $$;
commit;
begin;
-- Preserve every existing role accepted by a text CHECK constraint.
do $$
declare c record; role_num smallint;
begin
  select attnum into role_num from pg_attribute where attrelid='public.profiles'::regclass and attname='role';
  for c in select conname,pg_get_expr(conbin,conrelid) expr from pg_constraint
    where conrelid='public.profiles'::regclass and contype='c' and conkey=array[role_num] loop
    execute format('alter table public.profiles drop constraint %I',c.conname);
    execute format('alter table public.profiles add constraint %I check ((%s) or role::text = %L)',c.conname,c.expr,'organizer');
  end loop;
end $$;

create schema pantry_access;
revoke all on schema pantry_access from public,anon,authenticated,service_role;
grant usage on schema pantry_access to authenticated,service_role;

create table public.organizer_accounts (
  user_id uuid primary key references auth.users(id),
  display_name text not null check(length(btrim(display_name)) between 1 and 160),
  expires_at timestamptz not null check(isfinite(expires_at)),
  is_active boolean not null default true,
  can_create_tournaments boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.tournaments add column owner_user_id uuid references public.organizer_accounts(user_id);
create index tournaments_owner_user_id_idx on public.tournaments(owner_user_id) where owner_user_id is not null;
create table public.tournament_organizer_assignments (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  organizer_user_id uuid not null references public.organizer_accounts(user_id),
  created_at timestamptz not null default now(),
  primary key(tournament_id,organizer_user_id)
);
create index tournament_organizer_assignments_user_idx on public.tournament_organizer_assignments(organizer_user_id,tournament_id);

create function pantry_access.role_of(p_user uuid) returns text
language sql stable security definer set search_path='' as $$
  select lower(role::text) from public.profiles where id=p_user;
$$;
create function pantry_access.valid_organizer(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select pantry_access.role_of(p_user)='organizer' and exists (
    select 1 from public.organizer_accounts where user_id=p_user and is_active and expires_at>statement_timestamp());
$$;
create function pantry_access.can_manage(p_user uuid,p_tournament uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((p_user=auth.uid() or auth.role()='service_role' or pantry_access.role_of(auth.uid())='admin') and (
    pantry_access.role_of(p_user)='admin' or (
      pantry_access.valid_organizer(p_user) and (
        exists(select 1 from public.tournaments where id=p_tournament and owner_user_id=p_user)
        or exists(select 1 from public.tournament_organizer_assignments where tournament_id=p_tournament and organizer_user_id=p_user)
      )
    )
  ),false);
$$;
create function public.can_manage_tournament(user_id uuid,tournament_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select pantry_access.can_manage(user_id,tournament_id);
$$;
create function pantry_access.can_operate(p_tournament uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and (public.is_staff() or pantry_access.can_manage(auth.uid(),p_tournament));
$$;
create function pantry_access.can_operate_event(p_event uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select pantry_access.can_operate(tournament_id) from public.tournament_events where id=p_event),false);
$$;
create function pantry_access.require_tournament(p_tournament uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if pantry_access.role_of(auth.uid())='organizer' and not pantry_access.valid_organizer(auth.uid()) then
    raise exception 'Quyền vận hành đã hết hạn hoặc đã bị thu hồi.' using errcode='42501';
  end if;
  if not pantry_access.can_operate(p_tournament) then
    raise exception 'Bạn không có quyền vận hành giải đấu này.' using errcode='42501';
  end if;
end $$;
create function pantry_access.require_event(p_event uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pantry_access.require_tournament((select tournament_id from public.tournament_events where id=p_event));
end $$;
create function pantry_access.can_create() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(pantry_access.valid_organizer(auth.uid()) and
    (select can_create_tournaments from public.organizer_accounts where user_id=auth.uid()),false);
$$;

alter table public.organizer_accounts enable row level security;
alter table public.tournament_organizer_assignments enable row level security;
revoke all on public.organizer_accounts,public.tournament_organizer_assignments from public,anon,authenticated,service_role;
grant select on public.organizer_accounts,public.tournament_organizer_assignments to authenticated;
grant update(display_name,expires_at,is_active,can_create_tournaments) on public.organizer_accounts to authenticated;
grant insert(tournament_id,organizer_user_id),delete on public.tournament_organizer_assignments to authenticated;
create policy organizer_account_read on public.organizer_accounts for select to authenticated
  using(user_id=(select auth.uid()) or pantry_access.role_of(auth.uid())='admin');
create policy organizer_account_admin_update on public.organizer_accounts for update to authenticated
  using(pantry_access.role_of(auth.uid())='admin') with check(pantry_access.role_of(auth.uid())='admin');
create policy organizer_assignment_read on public.tournament_organizer_assignments for select to authenticated
  using(organizer_user_id=(select auth.uid()) or pantry_access.role_of(auth.uid())='admin');
create policy organizer_assignment_admin_insert on public.tournament_organizer_assignments for insert to authenticated
  with check(pantry_access.role_of(auth.uid())='admin' and not exists(
    select 1 from public.tournaments where id=tournament_id and owner_user_id=organizer_user_id));
create policy organizer_assignment_admin_delete on public.tournament_organizer_assignments for delete to authenticated
  using(pantry_access.role_of(auth.uid())='admin');
-- SELECT is already public. Do not widen existing INSERT/UPDATE column grants.
grant select(owner_user_id) on public.tournaments to authenticated;
create policy organizer_tournament_insert on public.tournaments for insert to authenticated
  with check(pantry_access.can_create() and owner_user_id=auth.uid());
create policy organizer_tournament_update on public.tournaments for update to authenticated
  using(pantry_access.role_of(auth.uid())='organizer' and pantry_access.can_manage(auth.uid(),id))
  with check(pantry_access.can_manage(auth.uid(),id));
create policy organizer_tournament_insert_limit on public.tournaments as restrictive for insert to authenticated
  with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer' or (pantry_access.can_create() and owner_user_id=auth.uid()));
create policy organizer_tournament_update_limit on public.tournaments as restrictive for update to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer' or pantry_access.can_manage(auth.uid(),id))
  with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer' or pantry_access.can_manage(auth.uid(),id));
-- Permanent deletion remains exclusively through the existing Admin RPC.
revoke delete on public.tournaments from public,anon,authenticated;

create function pantry_access.guard_tournament() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and new.owner_user_id is distinct from old.owner_user_id
    and pantry_access.role_of(auth.uid()) is distinct from 'admin' then
    raise exception 'Chỉ Pantry Admin được thay đổi chủ sở hữu giải.' using errcode='42501';
  end if;
  if pantry_access.role_of(auth.uid())='organizer' then
    if tg_op='INSERT' then
      if not pantry_access.valid_organizer(auth.uid()) then
        raise exception 'Quyền vận hành đã hết hạn hoặc đã bị thu hồi.' using errcode='42501';
      end if;
      if not pantry_access.can_create() then raise exception 'Tài khoản chưa được phép tự tạo giải.' using errcode='42501'; end if;
      if new.owner_user_id is not null and new.owner_user_id<>auth.uid() then
        raise exception 'Không được chọn chủ sở hữu khác.' using errcode='42501';
      end if;
      new.owner_user_id:=auth.uid(); new.created_by:=auth.uid();
    else
      perform pantry_access.require_tournament(old.id);
      if tg_op='DELETE' then raise exception 'Chỉ Pantry Admin được xóa giải.' using errcode='42501'; end if;
      if new.id<>old.id then raise exception 'Không được đổi mã giải.' using errcode='42501'; end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger organizer_tournament_guard before insert or update or delete on public.tournaments
  for each row execute function pantry_access.guard_tournament();

-- Independent of RLS, protect definer RPC writes and old/new row scopes.
create function pantry_access.guard_scoped_write() returns trigger
language plpgsql security definer set search_path='' as $$
declare row_data jsonb; tid uuid; eid uuid;
begin
  if pantry_access.role_of(auth.uid())='organizer' then
    for row_data in select value from jsonb_array_elements(case tg_op
      when 'INSERT' then jsonb_build_array(to_jsonb(new))
      when 'DELETE' then jsonb_build_array(to_jsonb(old))
      else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end) loop
      tid:=nullif(row_data->>'tournament_id','')::uuid;
      eid:=nullif(row_data->>'event_id','')::uuid;
      if tid is null then select tournament_id into tid from public.tournament_events where id=eid; end if;
      perform pantry_access.require_tournament(tid);
      if eid is not null and not exists(select 1 from public.tournament_events where id=eid and tournament_id=tid) then
        raise exception 'Sai nội dung giải đấu.' using errcode='42501';
      end if;
    end loop;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
do $$
declare tbl text; scope text;
begin
  foreach tbl in array array['tournament_events','teams','team_members','groups','group_teams','matches',
    'mlp_configs','mlp_slots','mlp_games','tournament_awards','tournament_info','player_flags',
    'referee_access_codes','referee_sessions','referee_score_logs','referee_live_actions','knockout_decisions'] loop
    scope:=case when tbl in ('team_members','group_teams','mlp_games','referee_live_actions','knockout_decisions')
      then 'pantry_access.can_operate_event(event_id)' else 'pantry_access.can_manage(auth.uid(),tournament_id)' end;
    execute format('create trigger organizer_scope_guard before insert or update or delete on public.%I
      for each row execute function pantry_access.guard_scoped_write()',tbl);
    -- No direct writes to private referee/knockout control records are added.
    if tbl not in ('referee_access_codes','referee_sessions','referee_score_logs','referee_live_actions','knockout_decisions') then
      execute format('create policy organizer_insert on public.%I for insert to authenticated with check
        (pantry_access.role_of(auth.uid())=''organizer'' and %s)',tbl,scope);
      execute format('create policy organizer_update on public.%I for update to authenticated using
        (pantry_access.role_of(auth.uid())=''organizer'' and %s) with check (%s)',tbl,scope,scope);
      execute format('create policy organizer_delete on public.%I for delete to authenticated using
        (pantry_access.role_of(auth.uid())=''organizer'' and %s)',tbl,scope);
    end if;
    execute format('create policy organizer_insert_limit on public.%I as restrictive for insert to authenticated
      with check(pantry_access.role_of(auth.uid()) is distinct from ''organizer'' or %s)',tbl,scope);
    execute format('create policy organizer_update_limit on public.%I as restrictive for update to authenticated
      using(pantry_access.role_of(auth.uid()) is distinct from ''organizer'' or %s)
      with check(pantry_access.role_of(auth.uid()) is distinct from ''organizer'' or %s)',tbl,scope,scope);
    execute format('create policy organizer_delete_limit on public.%I as restrictive for delete to authenticated
      using(pantry_access.role_of(auth.uid()) is distinct from ''organizer'' or %s)',tbl,scope);
    if tbl in ('referee_access_codes','referee_sessions','referee_score_logs','knockout_decisions') then
      execute format('create policy organizer_read on public.%I for select to authenticated using
        (pantry_access.role_of(auth.uid())=''organizer'' and %s)',tbl,scope);
    end if;
  end loop;
end $$;

alter table public.players enable row level security;
alter table public.player_flags enable row level security;
alter table public.profiles enable row level security;

-- A global player may be reused, never edited by an organizer across tournaments.
-- The scoped RPC below inserts players for the existing roster/import flow.
create policy organizer_players_insert_limit on public.players as restrictive for insert to authenticated
  with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer');
create policy organizer_players_update_limit on public.players as restrictive for update to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer')
  with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer');
create policy organizer_players_delete_limit on public.players as restrictive for delete to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer');
create function pantry_access.roster_player(p_tournament uuid,p_name text,p_gender text) returns table(id uuid,full_name text,gender text)
language plpgsql security definer set search_path='' as $$
declare player public.players; payload public.players;
begin
  perform pantry_access.require_tournament(p_tournament);
  if nullif(btrim(p_name),'') is null then raise exception 'Tên VĐV không được để trống.'; end if;
  select p.* into player from public.players p where p.full_name=btrim(p_name) order by p.id limit 1;
  if found then return query select player.id,player.full_name::text,player.gender::text; return; end if;
  payload:=jsonb_populate_record(null::public.players,jsonb_build_object('full_name',btrim(p_name),'gender',nullif(p_gender,'any')));
  insert into public.players(full_name,gender) values(payload.full_name,payload.gender) returning * into player;
  return query select player.id,player.full_name::text,player.gender::text;
end $$;
create function public.organizer_roster_player(p_tournament uuid,p_name text,p_gender text default null) returns table(id uuid,full_name text,gender text)
language sql security invoker set search_path='' as $$ select * from pantry_access.roster_player(p_tournament,p_name,p_gender); $$;

-- Existing poster paths start with the tournament UUID; keep public reads intact.
create function pantry_access.can_manage_poster(p_name text) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if split_part(p_name,'/',1) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return pantry_access.role_of(auth.uid())='organizer' and pantry_access.can_manage(auth.uid(),split_part(p_name,'/',1)::uuid);
end $$;
create policy organizer_poster_insert on storage.objects for insert to authenticated
  with check(bucket_id='tournament-posters' and pantry_access.can_manage_poster(name));
create policy organizer_poster_delete on storage.objects for delete to authenticated
  using(bucket_id='tournament-posters' and pantry_access.can_manage_poster(name));
create policy organizer_storage_insert_limit on storage.objects as restrictive for insert to authenticated
  with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer' or (bucket_id='tournament-posters' and pantry_access.can_manage_poster(name)));
create policy organizer_storage_update_limit on storage.objects as restrictive for update to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer') with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer');
create policy organizer_storage_delete_limit on storage.objects as restrictive for delete to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer' or (bucket_id='tournament-posters' and pantry_access.can_manage_poster(name)));

-- Organizer cannot promote themselves or modify other profiles via old policies.
create policy organizer_profile_insert_limit on public.profiles as restrictive for insert to authenticated
  with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer');
create policy organizer_profile_update_limit on public.profiles as restrictive for update to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer') with check(pantry_access.role_of(auth.uid()) is distinct from 'organizer');
create policy organizer_profile_delete_limit on public.profiles as restrictive for delete to authenticated
  using(pantry_access.role_of(auth.uid()) is distinct from 'organizer');

-- Replace only authorization expressions in installed routines, preserving their
-- deployed business logic. Abort on an unexpected definition instead of guessing.
do $$
declare item record; body text; changed text;
begin
  for item in select * from (values
    ('public.save_competition_event(uuid,uuid,text,time without time zone,text,integer,text)',
      'perform public._competition_require_staff();','perform pantry_access.require_tournament(p_tournament_id);'),
    ('public.set_mlp_style(uuid,text)',
      'perform public._competition_require_staff();','perform pantry_access.require_tournament(p_tournament_id);'),
    ('public.delete_competition_event(uuid)',
      'perform public._competition_require_staff();','perform pantry_access.require_event(p_event_id);'),
    ('public.set_referee_code(uuid,uuid,text,timestamp with time zone)',
      'not public.is_staff()','not pantry_access.can_operate(p_tournament_id)'),
    ('public.revoke_referee_code(uuid,uuid)',
      'not public.is_staff()','not pantry_access.can_operate(p_tournament_id)'),
    ('pantry_knockout.authorize(uuid)',
      'not public.is_staff()','not pantry_access.can_operate_event(p_event)'),
    ('pantry_knockout.prepare_generation(uuid,bigint,boolean)',
      'not public.is_staff()','not pantry_access.can_operate_event(p_event)'),
    ('pantry_knockout.guard_decision()',
      'not public.is_staff()','not pantry_access.can_operate_event(e)')
  ) as patches(signature,old_text,new_text) loop
    if to_regprocedure(item.signature) is null then raise exception 'Required existing RPC is missing: %',item.signature; end if;
    body:=pg_get_functiondef(to_regprocedure(item.signature));
    changed:=replace(body,item.old_text,item.new_text);
    if changed=body then raise exception 'Unexpected authorization in %. Migration rolled back; inspect this function.',item.signature; end if;
    execute changed;
  end loop;
end $$;
-- Admin-readable referee codes: keep existing Staff exclusion.
create or replace function public.admin_event_referee_codes(p_event_id uuid)
returns table(group_id uuid,readable_code text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not (
    pantry_access.role_of(auth.uid())='admin' or
    (pantry_access.role_of(auth.uid())='organizer' and pantry_access.can_operate_event(p_event_id))
  ) then raise exception 'Admin permission required' using errcode='42501'; end if;
  return query select c.group_id,c.readable_code from public.referee_access_codes c
    where c.event_id=p_event_id and c.active and (c.expires_at is null or c.expires_at>now());
end $$;

create function pantry_access.access_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare account public.organizer_accounts; owned uuid[]; assigned uuid[];
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập lại.' using errcode='42501'; end if;
  select * into account from public.organizer_accounts where user_id=auth.uid();
  select coalesce(array_agg(id),'{}') into owned from public.tournaments where owner_user_id=auth.uid();
  select coalesce(array_agg(tournament_id),'{}') into assigned from public.tournament_organizer_assignments where organizer_user_id=auth.uid();
  return jsonb_build_object('account',to_jsonb(account),'valid',coalesce(pantry_access.valid_organizer(auth.uid()),false),
    'owned_ids',owned,'assigned_ids',assigned,'server_now',statement_timestamp());
end $$;
create function public.organizer_access_state() returns jsonb
language sql stable security invoker set search_path='' as $$ select pantry_access.access_state(); $$;

create function pantry_access.list_accounts() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or pantry_access.role_of(auth.uid()) is distinct from 'admin' then
    raise exception 'Chỉ Pantry Admin được quản lý tài khoản khách.' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('email',u.email,
    'owned_count',(select count(*) from public.tournaments t where t.owner_user_id=a.user_id),
    'assigned_count',(select count(*) from public.tournament_organizer_assignments x where x.organizer_user_id=a.user_id))
    order by a.created_at desc) from public.organizer_accounts a join auth.users u on u.id=a.user_id),'[]'::jsonb);
end $$;
create function public.admin_organizer_accounts() returns jsonb
language sql stable security invoker set search_path='' as $$ select pantry_access.list_accounts(); $$;

-- Auth user creation happens on the server. This transaction sets the role and
-- account together, authorized with the requesting Admin's JWT (not user metadata).
create function pantry_access.register_account(p_user uuid,p_name text,p_expires timestamptz,p_can_create boolean) returns void
language plpgsql security definer set search_path='' as $$
declare target public.profiles;
begin
  if auth.uid() is null or pantry_access.role_of(auth.uid()) is distinct from 'admin' then
    raise exception 'Chỉ Pantry Admin được tạo tài khoản khách.' using errcode='42501';
  end if;
  if p_expires<=statement_timestamp() or not isfinite(p_expires) then raise exception 'Ngày hết hạn phải ở tương lai.'; end if;
  -- Only provision a newly created, still-banned Auth user from our endpoint.
  if not exists(select 1 from auth.users where id=p_user and created_at>statement_timestamp()-interval '10 minutes'
    and banned_until>statement_timestamp()) then raise exception 'Tài khoản chưa sẵn sàng để cấp quyền.'; end if;
  if exists(select 1 from public.organizer_accounts where user_id=p_user) then raise exception 'Tài khoản đã được cấp quyền.'; end if;
  target:=jsonb_populate_record(null::public.profiles,jsonb_build_object('id',p_user,'role','organizer','full_name',btrim(p_name)));
  insert into public.profiles(id,role,full_name) values(target.id,target.role,target.full_name)
    on conflict(id) do update set role=excluded.role,full_name=excluded.full_name;
  insert into public.organizer_accounts(user_id,display_name,expires_at,can_create_tournaments)
    values(p_user,btrim(p_name),p_expires,p_can_create);
end $$;
create function public.admin_register_organizer(p_user uuid,p_name text,p_expires timestamptz,p_can_create boolean) returns void
language sql security invoker set search_path='' as $$ select pantry_access.register_account(p_user,p_name,p_expires,p_can_create); $$;

-- LIVE calls this as service_role after validating the caller with Auth.getUser.
-- Staff/Admin behavior is unchanged; organizers are scoped to the real match.
create function pantry_access.video_access(p_user uuid,p_tournament uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Server authorization required' using errcode='42501'; end if;
  if pantry_access.role_of(p_user) in ('admin','staff') then return true; end if;
  if pantry_access.role_of(p_user)='organizer' and not pantry_access.valid_organizer(p_user) then
    raise exception 'Quyền vận hành đã hết hạn hoặc đã bị thu hồi.' using errcode='42501';
  end if;
  return pantry_access.can_manage(p_user,p_tournament);
end $$;
create function public.organizer_video_access(p_user uuid,p_tournament uuid) returns boolean
language sql stable security invoker set search_path='' as $$ select pantry_access.video_access(p_user,p_tournament); $$;

-- Private roster reads required by the existing team and awards editors.
create policy organizer_player_read on public.players for select to authenticated using (
  pantry_access.role_of(auth.uid())='organizer' and exists(
    select 1 from public.team_members tm join public.teams t on t.id=tm.team_id
    where tm.player_id=players.id and pantry_access.can_manage(auth.uid(),t.tournament_id))
);
create policy organizer_flag_read on public.player_flags for select to authenticated using (
  pantry_access.role_of(auth.uid())='organizer' and pantry_access.can_manage(auth.uid(),tournament_id)
);
-- No-op UPDATE/DELETE requests must also report expiration, rather than appearing
-- successful after RLS filters all rows. Check on every statement, including RPCs.
create function pantry_access.guard_active_statement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if pantry_access.role_of(auth.uid())='organizer' and not pantry_access.valid_organizer(auth.uid()) then
    raise exception 'Quyền vận hành đã hết hạn hoặc đã bị thu hồi.' using errcode='42501';
  end if;
  return null;
end $$;
do $$
declare tbl text;
begin
  foreach tbl in array array['tournaments','tournament_events','teams','team_members','groups','group_teams','matches',
    'mlp_configs','mlp_slots','mlp_games','tournament_awards','tournament_info','players','player_flags',
    'referee_access_codes','referee_sessions','referee_score_logs','referee_live_actions','knockout_decisions'] loop
    execute format('create trigger organizer_active_statement before insert or update or delete on public.%I
      for each statement execute function pantry_access.guard_active_statement()',tbl);
  end loop;
end $$;
-- Service-role LIVE writes still recheck the organizer at the database boundary.
-- Cleanup is allowed after expiration so existing sessions can be terminated.
create function pantry_access.guard_video_write() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status not in ('stopping','ended') and pantry_access.role_of(new.created_by)='organizer' then
    if not pantry_access.valid_organizer(new.created_by) then
      raise exception 'Quyền vận hành đã hết hạn hoặc đã bị thu hồi.' using errcode='42501';
    end if;
    if not pantry_access.can_manage(new.created_by,new.tournament_id) then
      raise exception 'Bạn không có quyền vận hành giải đấu này.' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger organizer_video_guard before insert or update on public.match_video_sessions
  for each row execute function pantry_access.guard_video_write();

-- No default public EXECUTE or broad table DML grants for the new helpers.
revoke all on all functions in schema pantry_access from public,anon,authenticated,service_role;
grant execute on function pantry_access.role_of(uuid),pantry_access.valid_organizer(uuid),
  pantry_access.can_manage(uuid,uuid),pantry_access.can_operate(uuid),pantry_access.can_operate_event(uuid),
  pantry_access.can_create(),pantry_access.can_manage_poster(text),pantry_access.access_state(),
  pantry_access.list_accounts(),pantry_access.register_account(uuid,text,timestamptz,boolean),
  pantry_access.roster_player(uuid,text,text) to authenticated;
grant execute on function pantry_access.can_manage(uuid,uuid),pantry_access.video_access(uuid,uuid) to service_role;
revoke all on function public.can_manage_tournament(uuid,uuid),public.organizer_access_state(),
  public.admin_organizer_accounts(),public.admin_register_organizer(uuid,text,timestamptz,boolean),
  public.organizer_roster_player(uuid,text,text),public.organizer_video_access(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.can_manage_tournament(uuid,uuid),public.organizer_access_state(),
  public.admin_organizer_accounts(),public.admin_register_organizer(uuid,text,timestamptz,boolean),
  public.organizer_roster_player(uuid,text,text) to authenticated;
grant execute on function public.can_manage_tournament(uuid,uuid),public.organizer_video_access(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
