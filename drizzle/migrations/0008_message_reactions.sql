create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
--> statement-breakpoint

alter table public.message_reactions enable row level security;
--> statement-breakpoint

grant select, insert, update, delete on public.message_reactions to authenticated;
--> statement-breakpoint

create policy "message reactions read chat members"
  on public.message_reactions for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id and (auth.uid() = m.sender_id or auth.uid() = m.receiver_id)
  ));
--> statement-breakpoint

create policy "message reactions insert own"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and not m.deleted_for_everyone
        and (auth.uid() = m.sender_id or auth.uid() = m.receiver_id)
    )
  );
--> statement-breakpoint

create policy "message reactions update own"
  on public.message_reactions for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and not m.deleted_for_everyone
        and (auth.uid() = m.sender_id or auth.uid() = m.receiver_id)
    )
  );
--> statement-breakpoint

create policy "message reactions delete own"
  on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());
--> statement-breakpoint

alter table public.message_reactions replica identity full;
--> statement-breakpoint

alter publication supabase_realtime add table public.message_reactions;
