alter table public.profiles
  add column if not exists telegram_alerts_changed_at timestamptz;
--> statement-breakpoint

notify pgrst, 'reload schema';
