alter table public.messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;
--> statement-breakpoint

update public.messages set delivered_at = created_at where status in ('delivered', 'read') and delivered_at is null;
--> statement-breakpoint

update public.messages set read_at = created_at where status = 'read' and read_at is null;