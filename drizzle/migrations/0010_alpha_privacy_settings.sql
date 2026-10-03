alter table public.profiles
  add column if not exists show_online_status boolean not null default true,
  add column if not exists read_receipts_enabled boolean not null default true;
