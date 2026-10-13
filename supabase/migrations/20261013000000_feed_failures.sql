-- Wrong feed-page passcode attempts, for a global rate limit (rows older than a day are pruned by the function).
create table public.feed_failures (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);
alter table public.feed_failures enable row level security;
revoke all on public.feed_failures from anon, authenticated;
