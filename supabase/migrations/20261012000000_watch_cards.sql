create table public.watch_cards (
  id bigint generated always as identity primary key,
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);

-- Locked down: only the edge function (service_role) touches this table.
alter table public.watch_cards enable row level security;
revoke all on public.watch_cards from anon, authenticated;
