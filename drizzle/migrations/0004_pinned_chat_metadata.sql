alter table public.pinned_chats
  add column if not exists id uuid,
  add column if not exists created_at timestamptz;

update public.pinned_chats
set id = coalesce(id, gen_random_uuid()),
    created_at = coalesce(created_at, pinned_at, now())
where id is null or created_at is null;

alter table public.pinned_chats
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  drop constraint if exists pinned_chats_pkey;

alter table public.pinned_chats
  add constraint pinned_chats_pkey primary key (id);

alter table public.pinned_chats
  drop constraint if exists pinned_chats_user_peer_unique;

alter table public.pinned_chats
  add constraint pinned_chats_user_peer_unique unique (user_id, peer_id);

grant all on public.pinned_chats, public.login_activity to service_role;