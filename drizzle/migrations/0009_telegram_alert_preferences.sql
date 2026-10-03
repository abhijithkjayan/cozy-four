alter table public.profiles
  add column if not exists is_online boolean not null default false,
  add column if not exists telegram_alerts_enabled boolean not null default true;
