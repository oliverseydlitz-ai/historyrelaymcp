# watch-card: context for Claude

Private card feed for Oliver's Apple Watch. Claude (claude.ai) saves short plain-text "cards" through an MCP connector, and an iPhone Shortcut fetches the newest card over HTTPS.

Oliver works **phone-only**: no PC, no local wrangler/Supabase CLI. All changes go through git pushes to `main`, plus the Supabase and Cloudflare dashboards.

## Status (2026-10-12): live and verified end to end
- MCP connector "Watch Card" in claude.ai: `save_card` returned "Saved card #1", `get_latest_card` returned it, and the row is in the DB.
- iPhone Shortcut: `GET /card/latest?format=text` with `READ_TOKEN` returns the card text.
- `https://watch.oliverseydlitz.com/health` returns `{"ok":true}`.
- GitHub Action deploy of the Supabase function: green.
- Telegram notification: card #5 produced "Watch card #5" from bot `oliver_watchcard2_bot` (the first bot, `oliver_watchcard_bot`, was replaced because its token was pasted into chat).
- Not done yet: rendering the card as an image on the watch (Scriptable script or Photos face).

## Architecture
```
claude.ai connector / iPhone Shortcut
        │ HTTPS
        ▼
watch.oliverseydlitz.com  (Cloudflare Worker "watch-card-proxy", cloudflare/worker.js)
        │ forwards path + query unchanged
        ▼
https://jdmahrrxtxqrcpcwmwvx.supabase.co/functions/v1/watch   (Supabase edge function, Deno)
        │ service_role
        ▼
Postgres table public.watch_cards  (project "oliverseydlitz-ai's Project", ref jdmahrrxtxqrcpcwmwvx, eu-west-1)
```

## Repo layout (GitHub: oliverseydlitz-ai/historyrelaymcp, public)
| Path | What |
|---|---|
| `supabase/functions/watch/index.ts` | The whole API + MCP server (one file, no MCP library: hand-written JSON-RPC) |
| `supabase/migrations/20261012000000_watch_cards.sql` | Table + RLS (already applied) |
| `supabase/migrations/20261013000000_feed_failures.sql` | Wrong-passcode log (`kind` = feed/admin) for rate limiting (already applied) |
| `supabase/migrations/20261013000001_watch_settings.sql` | Key/value settings edited from the admin page (already applied) |
| `supabase/config.toml` | `verify_jwt = false` for `watch` (the function does its own auth) |
| `cloudflare/worker.js` | Serves the feed page at `GET /`, proxies everything else to Supabase |
| `cloudflare/index.html` | Feed page + admin page (passcode keypad, card list, admin settings), bundled into the Worker as a text module |
| `cloudflare/wrangler.jsonc` | Worker name `watch-card-proxy`, custom domain route `watch.oliverseydlitz.com` |
| `.github/workflows/deploy-supabase.yml` | On push to `main` touching `supabase/**`: `supabase functions deploy watch --no-verify-jwt` |
| `.github/workflows/keepalive.yml` | Daily cron (06:17 UTC) that curls `/health` so the free Supabase project doesn't pause |
| `README.md` | Endpoints, curl examples, setup, secret rotation |

## API
Every response has `Cache-Control: no-store`. Tokens are compared in constant time (SHA-256 then XOR compare), and env values are `.trim()`med.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/health` | none | Runs a 1-row DB read; `{"ok":true}`, or 503 `{"ok":false}` if the DB fails |
| POST | `/card` | `Bearer WRITE_TOKEN` | `{"text"}`, trimmed, 1–1000 chars, else 400. Returns `{id, created_at}` |
| GET | `/card/latest` | `Bearer READ_TOKEN` | `{id, text, created_at}`, or 404 if empty. `?format=text` returns `text/plain` |
| GET | `/` | none | Feed page (served by the Cloudflare Worker, not Supabase, because Supabase turns function HTML into text/plain) |
| POST | `/cards` | `{"passcode"}` = `FEED_PASSCODE` | Newest 50 cards `{cards:[{id,text,created_at}]}`. Wrong code returns 401 and is logged; 10+ wrong codes in the last hour (global) returns 429 for everyone. `feed_enabled` off returns 403. No `FEED_PASSCODE` set returns 404 |
| POST | `/unlock` | `{"passcode"}` | What the keypad calls. Admin code returns `{role:"admin", settings, cards, stats}`; feed code returns `{role:"feed", cards}` (403 if the feed is paused); wrong code returns 401 and counts toward the limit |
| POST | `/admin` | `{"passcode"}` = `ADMIN_PASSCODE` (4 digits) | `{action}`: `state`, `post` `{text}`, `delete` `{id}`, `set` `{key, value:boolean}`, `set_recipients` `{recipients:[{name, chat_id}]}`, `reset_lockout`. Every action returns `{settings, cards, recipients, stats}` |
| POST | `/mcp/<MCP_PATH_SECRET>` | secret path | MCP Streamable HTTP, stateless, JSON responses. A wrong `/mcp/...` path returns 404 "Not Found". GET on the right path returns 405 (Safari shows that as a download) |

Wrong or missing token returns 401 with an empty body. Unknown routes return 404 JSON.

MCP tools:
- `save_card(text)` returns `"Saved card #<id>"`. Description: "Save a short plain-text card (max ~200 chars ideal, 1000 hard limit) to Oliver's Apple Watch card feed. Plain text only, no markdown."
- `get_latest_card()` returns `#<id> (<created_at>)\n<text>`.

Methods handled: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get a 202.

Telegram notification: after every successful insert (both `POST /card` and `save_card`; the hook lives in `insertCard`), the function calls Telegram Bot API `sendMessage` to each recipient (sent in parallel). Recipients come from `watch_settings` key `telegram_recipients` (`[{name, chat_id}]`, edited on the admin page, max 20); if that list is empty it falls back to the `TELEGRAM_CHAT_ID` env var (comma-separated) with the text `Watch card #<id>` (plus the card text when the `telegram_include_text` setting is on; skipped entirely when `telegram_enabled` is off; only recipient #1, Oliver, when `telegram_only_me` is on, so keep Oliver first in the list). It uses a 3 s AbortController timeout and is wrapped in try/catch. A failure only logs the HTTP status or error name, never the token or URL, and never changes the API/MCP response. If either env var is missing, the call is skipped silently. It is awaited, so a slow Telegram can add up to 3 s to a save.

## Data
```sql
create table public.watch_cards (
  id bigint generated always as identity primary key,
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);
-- RLS on; all privileges revoked from anon/authenticated. Only service_role (the function) touches it.
```
Pruning: after each insert, the function deletes everything beyond the newest 50 rows. This is two queries, not atomic, so two concurrent writes could briefly leave 51 rows. That's acceptable.

## Secrets
Edge Function secrets are set in the Supabase dashboard: `WRITE_TOKEN`, `READ_TOKEN`, `MCP_PATH_SECRET` (48 hex chars each), plus optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` `FEED_PASSCODE` (4-digit code for the feed page) and `ADMIN_PASSCODE` (4-digit code for the admin page; must differ from `FEED_PASSCODE`). Oliver keeps the values in his password manager. **Never commit them or write them into this file.**

GitHub repo secret: `SUPABASE_ACCESS_TOKEN`, a fine-grained Supabase token scoped to this project with Edge Functions read-write only. **It expires.** When the deploy Action starts failing with auth errors, generate a new one with the same scope.

Rotation: change the value in Supabase (Edge Functions → Secrets). Rotating `MCP_PATH_SECRET` changes the connector URL, so update it at claude.ai/settings/connectors.

## How to change things (phone-only)
- **Function code:** edit `supabase/functions/watch/index.ts` and push to `main`. The Action redeploys. Verify with the Watch Card MCP tools.
- **Proxy:** edit `cloudflare/*` and push to `main`. Cloudflare Workers Builds redeploys (root dir `cloudflare`, deploy command `npx wrangler deploy`, preview builds off).
- **Schema:** the Action does NOT run migrations. Apply them through the Supabase MCP tool and also add the SQL file under `supabase/migrations/`.

## Feed page
`https://watch.oliverseydlitz.com/` is public, but the cards load only after the server checks the 4-digit `FEED_PASSCODE`. The page remembers the code in localStorage and re-sends it on every refresh (auto-refresh every 30 s and when the tab regains focus). The lock button forgets it. A 4-digit code is weak on its own, so the global limit (10 wrong codes per hour) is what protects it. The trade-off is that someone hammering wrong codes can lock everyone out for up to an hour. The MCP endpoint is unaffected.

## Page design
`cloudflare/index.html` follows the `apple-design` skill (Apple's fluid-interface principles for the web): iOS system colors in light and dark, system font with size-specific tracking, an iPhone-style passcode pad (highlight on touch-down, spring shake on a wrong code), large titles that collapse into a translucent nav bar, Settings-style inset grouped lists on the admin page, and swipe-to-delete on admin cards (1:1 drag, rubber-banding, momentum projection, velocity hand-off into a spring). The spring helper uses Apple's damping ratio + response. It respects prefers-reduced-motion, prefers-reduced-transparency and prefers-contrast. No external scripts (the CSP blocks them). There is no custom pull-to-refresh, on purpose: it fights Safari's native scroll bounce, and auto-refresh plus the refresh button cover it.

## Admin page
There is one 4-digit keypad. It sends the code to `POST /unlock`, and the server decides: `ADMIN_PASSCODE` opens the admin panel, `FEED_PASSCODE` opens the feed (admin is checked first, so the two must differ). The admin code is kept only in page memory (never localStorage) and is re-checked by `/admin` on every action. Admin can post a card (same path as MCP saves, so Telegram fires), delete cards, flip the settings in `watch_settings` (`feed_enabled`, `telegram_enabled`, `telegram_include_text`, `telegram_only_me`; defaults true/true/false/false in `DEFAULT_SETTINGS`), edit the Telegram recipients list (numbered rows of name + chat ID, `set_recipients` action), and reset the wrong-code counter.

All wrong codes (feed, admin, `/unlock`, `/cards`, `/admin`) share one global counter: 10 per hour, then everything, admin included, returns 429 until it ages out. With a 4-digit admin code that limit is the only protection (roughly 3 weeks of nonstop guessing on average to find it). If a lockout blocks Oliver, clear it with `delete from public.feed_failures;` via Supabase SQL.

## Keepalive
Supabase pauses free projects after ~7 days without activity. The keepalive workflow hits `/health` daily, which reads the DB. **GitHub disables scheduled workflows in public repos after 60 days with no repo activity.** If that happens, re-enable it in the Actions tab (GitHub emails a warning first).

## Gotchas we hit
- **Secrets saved with the name prefix.** The value field got `MCP_PATH_SECRET=be47...` instead of just the hex. Supabase's DIGEST column is plain SHA-256 of the stored value, so you can check a value with `printf %s "<value>" | sha256sum`. The decisive test is behaviour: the MCP URL returns 404 if the secret is wrong and 405 or a download if it's right.
- **Supabase MCP `apply_migration` / multi-statement `execute_sql` timed out** (60 s) on DDL that included a plpgsql function. Single statements worked. If that happens, split the DDL into separate calls.
- **The Claude Code cloud sandbox cannot reach `*.supabase.co`** (egress policy) and could not reach Cloudflare docs. Test the live service through the Watch Card MCP tools, Supabase SQL, or Oliver's phone.
- An earlier Cloudflare-Workers + D1 version (wrangler-based) was built and then dropped because it needs a PC. Don't resurrect it.
- The repo name `historyrelaymcp` is historical. Oliver may rename it; the code doesn't depend on the name.
