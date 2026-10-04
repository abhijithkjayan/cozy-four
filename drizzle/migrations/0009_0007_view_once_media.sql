alter table public.messages
  add column if not exists view_once boolean not null default false,
  add column if not exists view_once_opened_at timestamptz;
--> statement-breakpoint

create or replace function public.open_view_once_message(p_message_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media_url text;
begin
  update public.messages
  set view_once_opened_at = now()
  where id = p_message_id
    and receiver_id = (select auth.uid())
    and view_once
    and view_once_opened_at is null
    and not deleted_for_everyone
    and media_url is not null
  returning media_url into v_media_url;

  return v_media_url;
end;
$$;
--> statement-breakpoint

revoke all on function public.open_view_once_message(uuid) from public;
--> statement-breakpoint
grant execute on function public.open_view_once_message(uuid) to authenticated;