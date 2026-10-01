alter table public.profiles
  add column if not exists status_text text not null default '';

create table if not exists public.pinned_chats (
  user_id uuid not null references public.profiles(id) on delete cascade,
  peer_id uuid not null references public.profiles(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (user_id, peer_id),
  check (user_id <> peer_id)
);

create table if not exists public.login_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  logged_in_at timestamptz not null default now()
);

alter table public.calls
  add column if not exists connected_at timestamptz;

create index if not exists login_activity_user_time_idx
  on public.login_activity (user_id, logged_in_at desc);

alter table public.pinned_chats enable row level security;
alter table public.login_activity enable row level security;

grant select, insert, delete on public.pinned_chats to authenticated;
grant select, insert on public.login_activity to authenticated;

create policy "pinned chats read own"
  on public.pinned_chats for select to authenticated
  using (user_id = auth.uid());
create policy "pinned chats insert own"
  on public.pinned_chats for insert to authenticated
  with check (user_id = auth.uid());
create policy "pinned chats delete own"
  on public.pinned_chats for delete to authenticated
  using (user_id = auth.uid());

create policy "login activity read approved chat members"
  on public.login_activity for select to authenticated
  using (
    user_id = auth.uid()
    or lower(coalesce((select auth.jwt() ->> 'email'), '')) in (
      'jamie@chat.local',
      'cersi@chat.local',
      'tyrion@chat.local',
      'tywin@chat.local'
    )
  );
create policy "login activity insert own"
  on public.login_activity for insert to authenticated
  with check (user_id = auth.uid());