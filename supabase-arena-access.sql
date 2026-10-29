-- Only Netlify server functions (service_role) can access these capabilities.
create table public.arena_access_codes (
 code_hash text primary key check(length(code_hash)=64),
 user_id uuid not null references auth.users(id) on delete cascade,
 challenge text not null check(length(challenge)=43),
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index arena_access_codes_expiry on public.arena_access_codes(expires_at);
create index arena_access_codes_user on public.arena_access_codes(user_id,created_at);
create table public.arena_access_sessions (
 token_hash text primary key check(length(token_hash)=64),
 user_id uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index arena_access_sessions_expiry on public.arena_access_sessions(expires_at);
alter table public.arena_access_codes enable row level security;
alter table public.arena_access_sessions enable row level security;
revoke all on public.arena_access_codes,public.arena_access_sessions from public,anon,authenticated;
grant select,insert,update,delete on public.arena_access_codes,public.arena_access_sessions to service_role;
notify pgrst, 'reload schema';
