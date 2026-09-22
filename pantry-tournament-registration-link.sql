-- Apply after pantry-tournament-info.sql. Existing events keep no link.
begin;

alter table public.tournament_info
  add column if not exists registration_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tournament_info'::regclass
      and conname = 'tournament_info_registration_https_check'
  ) then
    alter table public.tournament_info
      add constraint tournament_info_registration_https_check
      check (registration_url is null or
             registration_url ~ '^https://[^[:space:]/?#]+([/?#][^[:space:]]*)?$');
  end if;
end $$;

commit;
