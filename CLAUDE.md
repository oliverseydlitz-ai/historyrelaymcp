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
| `supabase/config.toml` | `verify_jwt = false` for `watch` (the function does its own auth) |
| `cloudflare/worker.js` | Proxy Worker (~10 lines) |
| `cloudflare/wrangler.jsonc` | Worker name `watch-card-proxy`, custom domain route `watch.oliverseydlitz.com` |
| `.github/workflows/deploy-supabase.yml` | On push to `main` touching `supabase/**`: `supabase functions deploy watch --no-verify-jwt` |
| `README.md` | Endpoints, curl examples, setup, secret rotation |

## API
Every response has `Cache-Control: no-store`. Tokens are compared in constant time (SHA-256 then XOR compare), and env values are `.trim()`med.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/health` | none | `{"ok":true}` |
| POST | `/card` | `Bearer WRITE_TOKEN` | `{"text"}`, trimmed, 1–1000 chars, else 400. Returns `{id, created_at}` |
| GET | `/card/latest` | `Bearer READ_TOKEN` | `{id, text, created_at}`, or 404 if empty. `?format=text` returns `text/plain` |
| POST | `/mcp/<MCP_PATH_SECRET>` | secret path | MCP Streamable HTTP, stateless, JSON responses. A wrong `/mcp/...` path returns 404 "Not Found". GET on the right path returns 405 (Safari shows that as a download) |

Wrong or missing token returns 401 with an empty body. Unknown routes return 404 JSON.

MCP tools:
- `save_card(text)` returns `"Saved card #<id>"`. Description: "Save a short plain-text card (max ~200 chars ideal, 1000 hard limit) to Oliver's Apple Watch card feed. Plain text only, no markdown."
- `get_latest_card()` returns `#<id> (<created_at>)\n<text>`.

Methods handled: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get a 202.

Telegram notification: after every successful insert (both `POST /card` and `save_card`; the hook lives in `insertCard`), the function calls Telegram Bot API `sendMessage` to `TELEGRAM_CHAT_ID` with the text `Watch card #<id>`. It uses a 3 s AbortController timeout and is wrapped in try/catch. A failure only logs the HTTP status or error name, never the token or URL, and never changes the API/MCP response. If either env var is missing, the call is skipped silently. It is awaited, so a slow Telegram can add up to 3 s to a save.

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
Edge Function secrets are set in the Supabase dashboard: `WRITE_TOKEN`, `READ_TOKEN`, `MCP_PATH_SECRET` (48 hex chars each), plus optional `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Oliver keeps the values in his password manager. **Never commit them or write them into this file.**

GitHub repo secret: `SUPABASE_ACCESS_TOKEN`, a fine-grained Supabase token scoped to this project with Edge Functions read-write only. **It expires.** When the deploy Action starts failing with auth errors, generate a new one with the same scope.

Rotation: change the value in Supabase (Edge Functions → Secrets). Rotating `MCP_PATH_SECRET` changes the connector URL, so update it at claude.ai/settings/connectors.

## How to change things (phone-only)
- **Function code:** edit `supabase/functions/watch/index.ts` and push to `main`. The Action redeploys. Verify with the Watch Card MCP tools.
- **Proxy:** edit `cloudflare/*` and push to `main`. Cloudflare Workers Builds redeploys (root dir `cloudflare`, deploy command `npx wrangler deploy`, preview builds off).
- **Schema:** the Action does NOT run migrations. Apply them through the Supabase MCP tool and also add the SQL file under `supabase/migrations/`.

## Gotchas we hit
- **Secrets saved with the name prefix.** The value field got `MCP_PATH_SECRET=be47...` instead of just the hex. Supabase's DIGEST column is plain SHA-256 of the stored value, so you can check a value with `printf %s "<value>" | sha256sum`. The decisive test is behaviour: the MCP URL returns 404 if the secret is wrong and 405 or a download if it's right.
- **Supabase MCP `apply_migration` / multi-statement `execute_sql` timed out** (60 s) on DDL that included a plpgsql function. Single statements worked. If that happens, split the DDL into separate calls.
- **The Claude Code cloud sandbox cannot reach `*.supabase.co`** (egress policy) and could not reach Cloudflare docs. Test the live service through the Watch Card MCP tools, Supabase SQL, or Oliver's phone.
- An earlier Cloudflare-Workers + D1 version (wrangler-based) was built and then dropped because it needs a PC. Don't resurrect it.
- The repo name `historyrelaymcp` is historical. Oliver may rename it; the code doesn't depend on the name.
