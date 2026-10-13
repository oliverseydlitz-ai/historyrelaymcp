import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_LEN = 1000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const enc = new TextEncoder();
const env = (k: string) => Deno.env.get(k)?.trim();

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function authorized(req: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  return m ? await safeEqual(m[1], token) : false;
}

function validateText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length === 0 || t.length > MAX_LEN ? null : t;
}

// Runtime settings (admin page). Missing rows fall back to these defaults.
// telegram_only_me: ping only the first ID in TELEGRAM_CHAT_ID (the owner) instead of everyone.
const DEFAULT_SETTINGS = { feed_enabled: true, telegram_enabled: true, telegram_include_text: false, telegram_only_me: false };
type Settings = typeof DEFAULT_SETTINGS;

async function getSettings(): Promise<Settings> {
  const out = { ...DEFAULT_SETTINGS };
  const { data, error } = await db.from("watch_settings").select("key, value");
  if (error || !data) return out;
  for (const row of data) {
    if (row.key in out && typeof row.value === typeof out[row.key as keyof Settings]) {
      (out as Record<string, unknown>)[row.key] = row.value;
    }
  }
  return out;
}

// Telegram recipients are edited on the admin page (watch_settings key "telegram_recipients").
// If that list is empty, fall back to the TELEGRAM_CHAT_ID env var. Row 1 is the owner ("only me").
type Recipient = { name: string; chat_id: string };
const MAX_RECIPIENTS = 20;

async function getRecipients(): Promise<Recipient[]> {
  const { data } = await db.from("watch_settings").select("value").eq("key", "telegram_recipients").maybeSingle();
  return Array.isArray(data?.value) ? (data.value as Recipient[]) : [];
}

function cleanRecipients(raw: unknown): Recipient[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RECIPIENTS) return null;
  const out: Recipient[] = [];
  for (const r of raw) {
    const name = typeof r?.name === "string" ? r.name.trim().slice(0, 40) : "";
    const chatId = typeof r?.chat_id === "string" ? r.chat_id.trim() : "";
    if (!name && !chatId) continue; // skip empty rows
    if (!/^-?\d{5,20}$/.test(chatId)) return null;
    out.push({ name, chat_id: chatId });
  }
  return out;
}

// Best-effort Telegram ping to every recipient; never throws, never logs the token.
async function notifyTelegram(id: number, text: string) {
  const settings = await getSettings();
  if (!settings.telegram_enabled) return;
  const message = settings.telegram_include_text ? `Watch card #${id}\n${text.slice(0, 3500)}` : `Watch card #${id}`;
  const token = env("TELEGRAM_BOT_TOKEN");
  const saved = (await getRecipients()).map((r) => r.chat_id);
  const allIds = saved.length ? saved : (env("TELEGRAM_CHAT_ID") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const chatIds = settings.telegram_only_me ? allIds.slice(0, 1) : allIds;
  if (!token || chatIds.length === 0) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    await Promise.all(chatIds.map(async (chatId) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          signal: ctrl.signal,
        });
        if (!res.ok) console.error(`telegram sendMessage failed: HTTP ${res.status}`);
      } catch (e) {
        console.error(`telegram sendMessage failed: ${e instanceof Error ? e.name : "unknown error"}`);
      }
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function insertCard(text: string) {
  const { data, error } = await db.from("watch_cards").insert({ text }).select("id, created_at").single();
  if (error || !data) throw new Error("insert failed");
  // Keep only the newest 50 rows.
  const { data: old } = await db.from("watch_cards").select("id").order("id", { ascending: false }).range(50, 1000);
  if (old && old.length) await db.from("watch_cards").delete().in("id", old.map((r) => r.id));
  await notifyTelegram(data.id as number, text);
  return { id: data.id as number, created_at: data.created_at as string };
}

async function latestCard() {
  const { data, error } = await db
    .from("watch_cards").select("id, text, created_at").order("id", { ascending: false }).limit(1);
  if (error) throw new Error("read failed");
  return data[0] ?? null;
}

// Passcodes: one global limit on wrong guesses, since 4-digit codes are easy to brute-force.
// Feed and admin codes are typed on the same keypad, so they share the counter.
const MAX_FAILURES_PER_HOUR = 10;

async function recentFailures(): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await db.from("feed_failures").select("id", { count: "exact", head: true }).gte("created_at", since);
  if (error) throw new Error("failure count failed");
  return count ?? 0;
}

async function recordFailure() {
  await db.from("feed_failures").insert({});
  await db.from("feed_failures").delete().lt("created_at", new Date(Date.now() - 86400_000).toISOString());
}

async function matches(name: string, given: unknown): Promise<boolean> {
  const expected = env(name);
  return !!expected && typeof given === "string" && (await safeEqual(given.trim(), expected));
}

// Checks one passcode env var with the rate limit. Returns an error Response, or null if it matches.
async function checkPasscode(name: string, given: unknown): Promise<Response | null> {
  if (!env(name)) return json({ error: "disabled" }, 404);
  if ((await recentFailures()) >= MAX_FAILURES_PER_HOUR) return json({ error: "too many attempts, try again later" }, 429);
  if (!(await matches(name, given))) {
    await recordFailure();
    return json({ error: "wrong passcode" }, 401);
  }
  return null;
}

async function adminState() {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const [settings, cards, fails, recipients] = await Promise.all([getSettings(), listCards(), recentFailures(), getRecipients()]);
  return { settings, cards, recipients, stats: { cards: cards.length, failures_last_hour: fails, max_failures_per_hour: MAX_FAILURES_PER_HOUR, since } };
}

async function listCards() {
  const { data, error } = await db
    .from("watch_cards").select("id, text, created_at").order("id", { ascending: false }).limit(50);
  if (error) throw new Error("read failed");
  return data;
}

const HEADERS = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json" } });

// ---- Minimal stateless MCP (Streamable HTTP, JSON responses) ----
const TOOLS = [
  {
    name: "save_card",
    description:
      "Save a short plain-text card (max ~200 chars ideal, 1000 hard limit) to Oliver's Apple Watch card feed. Plain text only, no markdown.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "get_latest_card",
    description: "Get the newest card in Oliver's Apple Watch card feed (text and timestamp).",
    inputSchema: { type: "object", properties: {} },
  },
];

const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === "save_card") {
    const text = validateText(args?.text);
    if (text === null) return textResult(`Text must be non-empty and at most ${MAX_LEN} characters.`, true);
    const { id } = await insertCard(text);
    return textResult(`Saved card #${id}`);
  }
  if (name === "get_latest_card") {
    const c = await latestCard();
    return textResult(c ? `#${c.id} (${c.created_at})\n${c.text}` : "No cards yet.");
  }
  return null;
}

async function handleRpc(msg: any): Promise<unknown | null> {
  const id = msg?.id;
  if (id === undefined) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "watch-card", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const r = await callTool(msg.params?.name, msg.params?.arguments ?? {});
        return r ? ok(r) : err(-32602, "Unknown tool");
      } catch {
        return ok(textResult("Internal error", true));
      }
    }
    default:
      return err(-32601, "Method not found");
  }
}

async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
  let body: any;
  try { body = await req.json(); } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleRpc))).filter((r) => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202, headers: HEADERS });
  return json(batch ? replies : replies[0]);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Accept both direct (/functions/v1/watch/...) and proxied paths.
  const path = url.pathname.replace(/^\/(functions\/v1\/)?watch(?=\/|$)/, "") || "/";

  try {
    if (path.startsWith("/mcp/")) {
      const secret = env("MCP_PATH_SECRET");
      if (!secret || !(await safeEqual(path, `/mcp/${secret}`))) return new Response("Not Found", { status: 404, headers: HEADERS });
      return await handleMcp(req);
    }
    if (path === "/health" && req.method === "GET") {
      // Touch the DB so pings count as project activity (keeps the free tier from pausing).
      const { error } = await db.from("watch_cards").select("id").limit(1);
      return error ? json({ ok: false }, 503) : json({ ok: true });
    }

    if (path === "/card" && req.method === "POST") {
      if (!(await authorized(req, env("WRITE_TOKEN")))) return new Response(null, { status: 401, headers: HEADERS });
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const text = validateText(body?.text);
      if (text === null) return json({ error: "text must be a non-empty string of at most 1000 characters" }, 400);
      return json(await insertCard(text));
    }

    if (path === "/cards" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      if (!(await getSettings()).feed_enabled) return json({ error: "feed paused" }, 403);
      const denied = await checkPasscode("FEED_PASSCODE", body?.passcode);
      if (denied) return denied;
      return json({ cards: await listCards() });
    }

    // The keypad: one 4-digit code decides between the admin panel and the feed.
    if (path === "/unlock" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      if ((await recentFailures()) >= MAX_FAILURES_PER_HOUR) return json({ error: "too many attempts, try again later" }, 429);
      if (await matches("ADMIN_PASSCODE", body?.passcode)) return json({ role: "admin", ...(await adminState()) });
      if (await matches("FEED_PASSCODE", body?.passcode)) {
        if (!(await getSettings()).feed_enabled) return json({ error: "feed paused" }, 403);
        return json({ role: "feed", cards: await listCards() });
      }
      await recordFailure();
      return json({ error: "wrong passcode" }, 401);
    }

    if (path === "/admin" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const denied = await checkPasscode("ADMIN_PASSCODE", body?.passcode);
      if (denied) return denied;

      switch (body.action ?? "state") {
        case "state":
          break;
        case "post": {
          const text = validateText(body.text);
          if (text === null) return json({ error: "text must be 1-1000 characters" }, 400);
          await insertCard(text);
          break;
        }
        case "delete": {
          if (!Number.isInteger(body.id)) return json({ error: "id must be an integer" }, 400);
          const { error } = await db.from("watch_cards").delete().eq("id", body.id);
          if (error) throw new Error("delete failed");
          break;
        }
        case "set": {
          if (!(body.key in DEFAULT_SETTINGS) || typeof body.value !== "boolean") return json({ error: "unknown setting" }, 400);
          const { error } = await db.from("watch_settings")
            .upsert({ key: body.key, value: body.value, updated_at: new Date().toISOString() });
          if (error) throw new Error("setting update failed");
          break;
        }
        case "set_recipients": {
          const recipients = cleanRecipients(body.recipients);
          if (!recipients) return json({ error: "each row needs a numeric chat ID (5-20 digits), max 20 rows" }, 400);
          const { error } = await db.from("watch_settings")
            .upsert({ key: "telegram_recipients", value: recipients, updated_at: new Date().toISOString() });
          if (error) throw new Error("recipients update failed");
          break;
        }
        case "reset_lockout": {
          const { error } = await db.from("feed_failures").delete().gte("id", 0);
          if (error) throw new Error("reset failed");
          break;
        }
        default:
          return json({ error: "unknown action" }, 400);
      }
      return json(await adminState());
    }

    if (path === "/card/latest" && req.method === "GET") {
      if (!(await authorized(req, env("READ_TOKEN")))) return new Response(null, { status: 401, headers: HEADERS });
      const card = await latestCard();
      if (!card) return json({ error: "no cards" }, 404);
      if (url.searchParams.get("format") === "text")
        return new Response(card.text, { headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
      return json(card);
    }
    return json({ error: "not found" }, 404);
  } catch {
    return json({ error: "internal error" }, 500);
  }
});
