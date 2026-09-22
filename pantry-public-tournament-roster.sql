-- Apply after the existing tournament/referee migrations. Safe to rerun.
-- Exposes only ordered player display names and a tournament player count.
begin;

create or replace function public.public_tournament_roster(p_tournament_id uuid)
returns table(team_id uuid, player_names text[], registered_players bigint)
language sql stable security definer
set search_path = '' as $$
  select t.id,
         coalesce(array_agg(p.full_name::text order by tm.slot_order)
           filter (where p.id is not null), array[]::text[]),
         (select count(distinct tm2.player_id)
          from public.teams t2
          join public.team_members tm2 on tm2.team_id = t2.id
          where t2.tournament_id = p_tournament_id)
  from public.teams t
  left join public.team_members tm on tm.team_id = t.id
  left join public.players p on p.id = tm.player_id
  where t.tournament_id = p_tournament_id
  group by t.id;
$$;

revoke all on function public.public_tournament_roster(uuid) from public, anon, authenticated;
grant execute on function public.public_tournament_roster(uuid) to anon, authenticated;

-- Preserve authenticated reads while removing any anonymous access inherited
-- from PUBLIC or granted directly, including column-level SELECT grants.
do $$
declare v_column record; v_auth_table boolean;
begin
  v_auth_table := has_table_privilege('authenticated', 'public.players', 'SELECT');
  for v_column in
    select attname,
           has_column_privilege('authenticated', 'public.players', attname, 'SELECT') as auth_can_select
    from pg_attribute
    where attrelid = 'public.players'::regclass
      and attnum > 0 and not attisdropped
  loop
    execute format('revoke select (%I) on public.players from public, anon', v_column.attname);
    if v_column.auth_can_select and not v_auth_table then
      execute format('grant select (%I) on public.players to authenticated', v_column.attname);
    end if;
  end loop;
  revoke select on public.players from public, anon;
  if v_auth_table then grant select on public.players to authenticated; end if;
end $$;
commit;
