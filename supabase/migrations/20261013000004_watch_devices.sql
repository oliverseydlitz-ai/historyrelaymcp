-- Signed-in devices for the admin page: one row per phone (random id stored on the phone, or "ip:<ip>").
create table public.watch_devices (
  device_id text primary key,
  role text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  logins int not null default 0,
  ip text,
  country text,
  city text,
  asn text,
  user_agent text,
  geo jsonb,     -- extra Cloudflare request.cf fields (region, postcode, timezone, lat/lon, ASN, colo, protocol, TLS)
  client jsonb   -- what the page reports (screen, language, timezone, home-screen app, ...)
);
alter table public.watch_devices enable row level security;
revoke all on public.watch_devices from anon, authenticated;
