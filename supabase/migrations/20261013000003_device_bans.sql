-- Per-device brute-force protection: wrong codes carry the caller's IP and location (sent by the
-- Cloudflare Worker, proven with PROXY_SECRET); 5 wrong codes from one IP in 24 hours bans it.
alter table public.feed_failures
  add column ip text, add column country text, add column city text, add column asn text, add column user_agent text;

create table public.watch_bans (
  ip text primary key,
  banned_at timestamptz not null default now(),
  failures int not null default 0,
  country text,
  city text,
  asn text,
  user_agent text
);
alter table public.watch_bans enable row level security;
revoke all on public.watch_bans from anon, authenticated;
