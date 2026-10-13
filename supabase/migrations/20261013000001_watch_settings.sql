-- Runtime settings edited from the admin page (feed_enabled, telegram_enabled, telegram_include_text).
create table public.watch_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.watch_settings enable row level security;
revoke all on public.watch_settings from anon, authenticated;
