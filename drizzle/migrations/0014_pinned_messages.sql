alter table public.messages
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references public.profiles(id) on delete set null;
--> statement-breakpoint

create index if not exists messages_pinned_idx on public.messages (pinned_at) where pinned_at is not null;
--> statement-breakpoint

notify pgrst, 'reload schema';
