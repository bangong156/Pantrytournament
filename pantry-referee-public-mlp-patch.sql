-- Pantry Tournament Referee Mode — public read patch for MLP style
-- Run once after pantry-referee-mode.sql.
begin;

drop policy if exists "public read mlp configs" on public.mlp_configs;
create policy "public read mlp configs"
on public.mlp_configs for select
to anon, authenticated
using (true);

grant select on public.mlp_configs to anon, authenticated;

commit;

select 'REFEREE PUBLIC PATCH READY' as status;
