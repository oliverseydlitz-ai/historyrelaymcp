# watch-card (repo: historyrelaymcp)

Tiny private API + MCP server: a Supabase edge function (Deno) backed by Postgres. Claude saves short text cards via MCP; an iPhone Shortcut / Scriptable script fetches the latest one over HTTPS for an Apple Watch. Only the newest 50 cards are kept.

- Supabase project: `jdmahrrxtxqrcpcwmwvx` (function `watch`, table `public.watch_cards`, RLS on, no anon/authenticated access)
- Public host: `https://watch.oliverseydlitz.com` (a Cloudflare Worker proxy, `cloudflare/worker.js`, forwards to `https://jdmahrrxtxqrcpcwmwvx.supabase.co/functions/v1/watch`)

## Endpoints
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/card` | `WRITE_TOKEN` | `{"text": "..."}`, trimmed, 1-1000 chars. Returns `{id, created_at}` |
| GET | `/card/latest` | `READ_TOKEN` | `{id, text, created_at}`; 404 if empty; `?format=text` returns plain text |
| GET | `/health` | none | `{"ok": true}` |
| GET | `/` | none | Feed page for phones (served by the Cloudflare Worker) |
| POST | `/cards` | `{"passcode"}` | Newest 50 cards, if the passcode matches `FEED_PASSCODE` (10 wrong tries/hour max) |
| POST | `/mcp/<MCP_PATH_SECRET>` | secret path | MCP Streamable HTTP (stateless, JSON). Tools: `save_card`, `get_latest_card` |

```sh
curl -X POST https://watch.oliverseydlitz.com/card \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Standup 10:00"}'

curl "https://watch.oliverseydlitz.com/card/latest?format=text" \
  -H "Authorization: Bearer $READ_TOKEN"
```

## Setup
1. **Database**: `supabase/migrations/*_watch_cards.sql` (already applied to the project).
2. **Edge function**: `supabase/functions/watch/index.ts`, deployed with JWT verification **off** (the function checks its own tokens).
3. **Secrets**: Supabase dashboard -> Edge Functions -> Secrets. Add `WRITE_TOKEN`, `READ_TOKEN`, `MCP_PATH_SECRET` (each e.g. `openssl rand -hex 24`, or generated in a password manager). Optional: `FEED_PASSCODE` (4 digits, enables the feed page). Optional: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (comma-separate several IDs to notify several people) to get a "Watch card #<id>" Telegram message on every new card (skipped if either is missing).
4. **Domain**: Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> paste `cloudflare/worker.js` -> Deploy -> Settings -> Domains & Routes -> Add -> Custom domain -> `watch.oliverseydlitz.com`. Cloudflare creates the DNS record.
5. **Claude.ai**: Settings -> Connectors -> Add custom connector -> `https://watch.oliverseydlitz.com/mcp/<MCP_PATH_SECRET>` (no auth).

## Rotating secrets
Edit the secret in Supabase dashboard -> Edge Functions -> Secrets; it applies to new invocations. Rotating `MCP_PATH_SECRET` changes the MCP URL, so update the Claude.ai connector.

## Deploy from git (no PC needed)
- **Supabase function**: pushing to `main` runs `.github/workflows/deploy-supabase.yml`. Needs the GitHub secret `SUPABASE_ACCESS_TOKEN` (Supabase -> Account -> Access Tokens). Schema changes are not auto-applied; run migrations through Claude/Supabase.
- **Cloudflare proxy**: Workers & Pages -> Create -> Import a repository -> this repo, root directory `cloudflare`. `cloudflare/wrangler.jsonc` attaches `watch.oliverseydlitz.com` automatically.
