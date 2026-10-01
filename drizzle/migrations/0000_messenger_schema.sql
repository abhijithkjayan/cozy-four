create table public.profiles (
  id uuid primary key,
  user_id text unique not null,
  display_name text not null,
  avatar_url text,
  last_seen timestamptz default now()
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  type text not null default 'text' check (type in ('text','image','audio','call','location','gif','sticker')),
  content text,
  media_url text,
  reply_to uuid references public.messages(id) on delete set null,
  status text not null default 'sent' check (status in ('sent','delivered','read')),
  created_at timestamptz not null default now(),
  deleted_for uuid[] not null default '{}',
  deleted_for_everyone boolean not null default false
);
create index messages_pair_idx on public.messages (sender_id, receiver_id, created_at desc);
create index messages_receiver_idx on public.messages (receiver_id, status);
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('voice','video')),
  status text not null default 'ringing' check (status in ('ringing','active','ended','missed','declined')),
  started_at timestamptz default now(),
  ended_at timestamptz
);
grant select, insert, update, delete on public.profiles, public.messages, public.calls to authenticated;
grant all on public.profiles, public.messages, public.calls to service_role;
alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.calls enable row level security;
create policy "profiles read" on public.profiles for select to authenticated using (true);
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "messages read" on public.messages for select to authenticated using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "messages insert" on public.messages for insert to authenticated with check (auth.uid() = sender_id and sender_id <> receiver_id);
create policy "messages update" on public.messages for update to authenticated using (auth.uid() = sender_id or auth.uid() = receiver_id) with check (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "calls read" on public.calls for select to authenticated using (auth.uid() = caller_id or auth.uid() = receiver_id);
create policy "calls insert" on public.calls for insert to authenticated with check (auth.uid() = caller_id);
create policy "calls update" on public.calls for update to authenticated using (auth.uid() = caller_id or auth.uid() = receiver_id);
alter table public.messages replica identity full;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.calls;
create policy "chat-media read participants" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and ((storage.foldername(name))[1] = auth.uid()::text or (storage.foldername(name))[2] = auth.uid()::text));
create policy "chat-media upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "chat-media delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text);