-- Apply after pantry-tournament-awards.sql. Safe to rerun.
-- Existing awards remain in slot 1 with their display snapshots unchanged.
begin;

alter table public.tournament_awards
  add column if not exists placement_slot integer not null default 1;
update public.tournament_awards set placement_slot = 1 where placement_slot is null;
alter table public.tournament_awards
  alter column placement_slot set default 1,
  alter column placement_slot set not null;
alter table public.tournament_awards
  add column if not exists team_id uuid references public.teams(id) on delete set null;

alter table public.tournament_awards
  drop constraint if exists tournament_awards_tournament_id_placement_key;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.tournament_awards'::regclass
                   and conname = 'tournament_awards_placement_slot_check') then
    alter table public.tournament_awards
      add constraint tournament_awards_placement_slot_check
      check (placement_slot = 1 or (placement = 3 and placement_slot = 2));
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.tournament_awards'::regclass
                   and conname = 'tournament_awards_tournament_placement_slot_key') then
    alter table public.tournament_awards
      add constraint tournament_awards_tournament_placement_slot_key
      unique (tournament_id, placement, placement_slot);
  end if;
end $$;

-- Existing public-read and admin-write RLS policies remain in force.
commit;
