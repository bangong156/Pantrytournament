-- Apply after pantry-referee-hardening.sql. Safe to rerun.
-- Older hashes cannot be reversed; readable_code stays null until rotation.
begin;

alter table public.referee_access_codes
  add column if not exists readable_code text;

-- Existing staff status queries retain only these columns. The readable value
-- is available solely through the admin-checked RPC below.
revoke select on public.referee_access_codes from public, anon, authenticated;
grant select (id, tournament_id, group_id, active, expires_at, created_at, updated_at)
  on public.referee_access_codes to authenticated;

create or replace function public.set_referee_code(
  p_tournament_id uuid, p_group_id uuid, p_code text,
  p_expires_at timestamptz default null
)
returns uuid language plpgsql security definer
set search_path = public, extensions as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Staff permission required';
  end if;
  if p_code is null or length(trim(p_code)) < 8 then
    raise exception 'Referee code must contain at least 8 characters';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Referee code expiry must be in the future';
  end if;
  if not exists (select 1 from public.groups g
                 where g.id = p_group_id and g.tournament_id = p_tournament_id) then
    raise exception 'Group does not belong to this tournament';
  end if;
  insert into public.referee_access_codes
    (tournament_id, group_id, code_hash, readable_code, active, expires_at, created_by,
     updated_at, failed_attempts, locked_until)
  values
    (p_tournament_id, p_group_id, crypt(trim(p_code), gen_salt('bf')), trim(p_code),
     true, p_expires_at, auth.uid(), now(), 0, null)
  on conflict (tournament_id, group_id) do update set
    code_hash = excluded.code_hash, readable_code = excluded.readable_code, active = true,
    expires_at = excluded.expires_at, created_by = auth.uid(),
    updated_at = now(), failed_attempts = 0, locked_until = null
  returning id into v_id;
  update public.referee_sessions set active = false
  where tournament_id = p_tournament_id and group_id = p_group_id;
  return v_id;
end;
$$;


create or replace function public.admin_referee_codes(p_tournament_id uuid)
returns table(group_id uuid, readable_code text)
language plpgsql security definer
set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role::text) = 'admin'
  ) then
    raise exception 'Admin permission required' using errcode = '42501';
  end if;
  return query
    select c.group_id, c.readable_code
    from public.referee_access_codes c
    where c.tournament_id = p_tournament_id and c.active
      and (c.expires_at is null or c.expires_at > now());
end;
$$;

revoke all on function public.set_referee_code(uuid,uuid,text,timestamptz) from public;
grant execute on function public.set_referee_code(uuid,uuid,text,timestamptz) to authenticated;
revoke all on function public.admin_referee_codes(uuid) from public, anon;
grant execute on function public.admin_referee_codes(uuid) to authenticated;
commit;
