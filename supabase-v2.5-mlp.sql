-- Pantry Tournament V2.5 - MLP persistence migration
-- Safe to run more than once.

begin;

-- 1) Persist the selected MLP style explicitly.
alter table public.mlp_configs
  add column if not exists style text;

update public.mlp_configs
set style = case when members_per_team = 3 then 'mini' else 'basic' end
where style is null;

alter table public.mlp_configs
  alter column style set default 'basic';

alter table public.mlp_configs
  alter column style set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'mlp_configs_style_check'
      and conrelid = 'public.mlp_configs'::regclass
  ) then
    alter table public.mlp_configs
      add constraint mlp_configs_style_check check (style in ('basic','mini'));
  end if;
end $$;

-- 2) Keep MLP config one-per-tournament.
create unique index if not exists mlp_configs_tournament_uidx
  on public.mlp_configs(tournament_id);

-- 3) Keep one slot number per MLP tournament.
create unique index if not exists mlp_slots_tournament_order_uidx
  on public.mlp_slots(tournament_id, slot_order);

-- 4) Keep one member in each team slot. This also prevents duplicate slot inserts.
create unique index if not exists team_members_team_slot_uidx
  on public.team_members(team_id, slot_order);

-- 5) Backfill existing slot labels/genders according to the two supported styles.
update public.mlp_slots s
set slot_name = case s.slot_order
    when 1 then 'Nam 1'
    when 2 then 'Nam 2'
    when 3 then 'Nữ 1'
    when 4 then 'Nữ 2'
    else s.slot_name
  end,
  gender = case when s.slot_order in (1,2) then 'male'
                when s.slot_order in (3,4) then 'female'
                else s.gender end
from public.mlp_configs c
where c.tournament_id = s.tournament_id
  and c.style = 'basic';

update public.mlp_slots s
set slot_name = 'VĐV ' || s.slot_order,
    gender = 'any'
from public.mlp_configs c
where c.tournament_id = s.tournament_id
  and c.style = 'mini';

-- 6) RPC: create/reconfigure the two supported MLP styles atomically.
create or replace function public.set_mlp_style(
  p_tournament_id uuid,
  p_style text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_members integer;
begin
  if p_style not in ('basic','mini') then
    raise exception 'Unsupported MLP style: %', p_style;
  end if;

  if not exists (
    select 1 from public.tournaments
    where id = p_tournament_id and format = 'mlp'
  ) then
    raise exception 'Tournament is not MLP or does not exist';
  end if;

  v_members := case when p_style = 'mini' then 3 else 4 end;

  insert into public.mlp_configs(tournament_id, members_per_team, style)
  values (p_tournament_id, v_members, p_style)
  on conflict (tournament_id)
  do update set members_per_team = excluded.members_per_team,
                style = excluded.style;

  delete from public.mlp_slots where tournament_id = p_tournament_id;

  if p_style = 'mini' then
    insert into public.mlp_slots(tournament_id, slot_order, slot_name, gender, max_rating)
    values
      (p_tournament_id,1,'VĐV 1','any',null),
      (p_tournament_id,2,'VĐV 2','any',null),
      (p_tournament_id,3,'VĐV 3','any',null);
  else
    insert into public.mlp_slots(tournament_id, slot_order, slot_name, gender, max_rating)
    values
      (p_tournament_id,1,'Nam 1','male',null),
      (p_tournament_id,2,'Nam 2','male',null),
      (p_tournament_id,3,'Nữ 1','female',null),
      (p_tournament_id,4,'Nữ 2','female',null);
  end if;
end;
$$;

grant execute on function public.set_mlp_style(uuid,text) to authenticated;

commit;
