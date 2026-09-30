-- =====================================================================
-- Private Messenger — full setup. Paste into Supabase SQL Editor and Run.
-- Safe to re-run.
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  user_id text unique not null,
  display_name text not null,
  avatar_url text,
  last_seen timestamptz default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  type text not null default 'text' check (type in ('text','image','audio','call')),
  content text,
  media_url text,
  reply_to uuid references public.messages(id) on delete set null,
  status text not null default 'sent' check (status in ('sent','delivered','read')),
  created_at timestamptz not null default now(),
  deleted_for uuid[] not null default '{}',
  deleted_for_everyone boolean not null default false
);
create index if not exists messages_pair_idx on public.messages (sender_id, receiver_id, created_at desc);
create index if not exists messages_receiver_idx on public.messages (receiver_id, status);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('voice','video')),
  status text not null default 'ringing' check (status in ('ringing','active','ended','missed','declined')),
  started_at timestamptz default now(),
  ended_at timestamptz
);

-- ---------- Grants ----------
grant select, insert, update, delete on public.profiles, public.messages, public.calls to authenticated;
grant all on public.profiles, public.messages, public.calls to service_role;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.calls enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "messages read" on public.messages;
create policy "messages read" on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages for insert to authenticated
  with check (auth.uid() = sender_id and sender_id <> receiver_id);
drop policy if exists "messages update" on public.messages;
create policy "messages update" on public.messages for update to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id)
  with check (auth.uid() = sender_id or auth.uid() = receiver_id);

drop policy if exists "calls read" on public.calls;
create policy "calls read" on public.calls for select to authenticated
  using (auth.uid() = caller_id or auth.uid() = receiver_id);
drop policy if exists "calls insert" on public.calls;
create policy "calls insert" on public.calls for insert to authenticated with check (auth.uid() = caller_id);
drop policy if exists "calls update" on public.calls;
create policy "calls update" on public.calls for update to authenticated
  using (auth.uid() = caller_id or auth.uid() = receiver_id);

-- ---------- Realtime ----------
alter table public.messages replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.calls; exception when duplicate_object then null; end;
end $$;

-- ---------- Storage: chat-media (private) ----------
-- Paths are "<sender_uuid>/<receiver_uuid>/<file>"
insert into storage.buckets (id, name, public) values ('chat-media','chat-media', false)
on conflict (id) do nothing;

drop policy if exists "chat-media read participants" on storage.objects;
create policy "chat-media read participants" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and (
    (storage.foldername(name))[1] = auth.uid()::text or (storage.foldername(name))[2] = auth.uid()::text));
drop policy if exists "chat-media upload own" on storage.objects;
create policy "chat-media upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "chat-media delete own" on storage.objects;
create policy "chat-media delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Seed 4 users (password 00000 → stored as 00000_pad_secure) ----------
do $$
declare
  u text; uid uuid; em text; pw text := '00000_pad_secure';
begin
  foreach u in array array['user1','user2','user3','user4'] loop
    em := u || '@chat.local';
    select id into uid from auth.users where email = em;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
        crypt(pw, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text,
        jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
    end if;
    insert into public.profiles (id, user_id, display_name) values (uid, u, u)
    on conflict (id) do nothing;
  end loop;
end $$;
