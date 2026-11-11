alter table public.messages add column if not exists pinned_at timestamptz, add column if not exists pinned_by uuid references public.profiles(id) on delete set null;
create index if not exists messages_pinned_idx on public.messages (pinned_at) where pinned_at is not null;
alter table public.profiles add column if not exists telegram_alerts_changed_at timestamptz;
notify pgrst, 'reload schema';