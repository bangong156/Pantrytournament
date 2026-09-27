-- Minimal local schema required to execute the real preparation + engine RPCs.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function public.is_staff() returns boolean language sql stable as $$ select current_setting('test.staff',true)='true' $$;
create function public._competition_write_scope(e uuid) returns boolean language sql stable as $$ select e::text=current_setting('test.event',true) $$;
create table public.tournament_events(id uuid primary key,tournament_id uuid,format text,status text);
create table public.groups(id uuid primary key,event_id uuid,tournament_id uuid,name text,group_order integer,unique(id,event_id));
create table public.teams(id uuid primary key,event_id uuid,name text,unique(id,event_id));
create table public.group_teams(id uuid primary key default gen_random_uuid(),event_id uuid,group_id uuid,team_id uuid,position integer);
create table public.matches(
 id uuid primary key default gen_random_uuid(),event_id uuid,tournament_id uuid,group_id uuid,
 match_code text,stage text constraint matches_stage_check check(stage in ('group','round_of_32','round_of_16','quarterfinal','semifinal','third_place','final')),
 team1_id uuid,team2_id uuid,team1_score integer,team2_score integer,winner_id uuid,court_number integer,
 status text default 'scheduled',scheduled_order integer,started_at timestamptz,completed_at timestamptz,
 score_version bigint default 0,unique(id,event_id),unique(event_id,match_code),
 foreign key(team1_id,event_id) references teams(id,event_id) deferrable initially deferred,
 foreign key(team2_id,event_id) references teams(id,event_id) deferrable initially deferred,
 foreign key(winner_id,event_id) references teams(id,event_id) deferrable initially deferred);
create table public.mlp_games(id uuid primary key default gen_random_uuid(),event_id uuid,match_id uuid references matches(id));
grant usage on schema public,auth to authenticated;
grant select on public.matches to authenticated;
