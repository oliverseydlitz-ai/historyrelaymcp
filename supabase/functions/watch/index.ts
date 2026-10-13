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

// Passcodes: 4-digit codes are easy to brute-force, so there are two layers.
// 1. Per device (IP): 5 wrong codes within 24 hours blocks that IP permanently (unblock on the admin page).
//    A correct code resets that device's count.
// 2. Global backstop: 10 wrong codes per hour from anywhere locks the keypad for everyone, since an
//    attacker can change IPs. Feed and admin codes share one keypad, so they share both counters.
const MAX_FAILURES_PER_HOUR = 10;
const MAX_FAILURES_PER_DEVICE_PER_DAY = 5;

type Client = {
  ip: string | null; country: string | null; city: string | null; asn: string | null; user_agent: string | null;
  geo?: Record<string, string | number | boolean> | null;
};

// Keeps only short primitive values from an untrusted object (Worker geo header, device info from the page).
function cleanObject(raw: unknown, maxKeys = 24): Record<string, string | number | boolean> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw).slice(0, maxKeys)) {
    if (!/^[a-z_]{1,32}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
const decodeHeader = (v: string | null) => {
  if (!v) return null;
  try { return decodeURIComponent(v).slice(0, 120) || null; } catch { return null; }
};

// Who is calling. The Cloudflare Worker adds the real client IP and location plus PROXY_SECRET as proof.
// Returns null when PROXY_SECRET is set but the request didn't come through the Worker (spoofing attempt).
// Without PROXY_SECRET, per-device blocking is off and only the global limit applies.
async function clientOf(req: Request): Promise<Client | null> {
  const user_agent = req.headers.get("user-agent")?.slice(0, 300) ?? null;
  const secret = env("PROXY_SECRET");
  if (!secret) return { ip: null, country: null, city: null, asn: null, user_agent };
  if (!(await safeEqual(req.headers.get("x-watch-proxy-key") ?? "", secret))) return null;
  return {
    ip: req.headers.get("x-watch-client-ip")?.trim().slice(0, 64) || null,
    country: decodeHeader(req.headers.get("x-watch-country")),
    city: decodeHeader(req.headers.get("x-watch-city")),
    asn: decodeHeader(req.headers.get("x-watch-asorg")),
    user_agent,
    geo: (() => {
      try { return cleanObject(JSON.parse(decodeURIComponent(req.headers.get("x-watch-geo") ?? "").slice(0, 2000))); } catch { return null; }
    })(),
  };
}

async function recentFailures(): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await db.from("feed_failures").select("id", { count: "exact", head: true }).gte("created_at", since);
  if (error) throw new Error("failure count failed");
  return count ?? 0;
}

async function isBlocked(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const { data } = await db.from("watch_bans").select("ip").eq("ip", ip).maybeSingle();
  return !!data;
}

// Runs before any passcode is checked. Returns an error Response, or null to continue.
async function gate(client: Client | null): Promise<Response | null> {
  if (!client) return json({ error: "forbidden" }, 400);
  if (await isBlocked(client.ip)) return json({ error: "device blocked" }, 423);
  if ((await recentFailures()) >= MAX_FAILURES_PER_HOUR) return json({ error: "too many attempts, try again later" }, 429);
  return null;
}

// Logs a wrong code; blocks the device on its 5th wrong code in 24 hours. Returns the response to send.
async function wrongCode(c: Client): Promise<Response> {
  const { ip, country, city, asn, user_agent } = c;
  await db.from("feed_failures").insert({ ip, country, city, asn, user_agent });
  await db.from("feed_failures").delete().lt("created_at", new Date(Date.now() - 86400_000).toISOString());
  if (!ip) return json({ error: "wrong passcode" }, 401);
  const { count } = await db.from("feed_failures").select("id", { count: "exact", head: true })
    .eq("ip", ip).gte("created_at", new Date(Date.now() - 86400_000).toISOString());
  const n = count ?? 0;
  if (n >= MAX_FAILURES_PER_DEVICE_PER_DAY) {
    await db.from("watch_bans").upsert({ ip, failures: n, country, city, asn, user_agent, banned_at: new Date().toISOString() });
    return json({ error: "device blocked" }, 423);
  }
  return json({ error: "wrong passcode", left: MAX_FAILURES_PER_DEVICE_PER_DAY - n }, 401);
}

// Signed-in devices for the admin page. The page sends a random per-phone id plus screen/language info.
// Sign-ins (/unlock) always update; background refreshes update at most every 5 minutes.
async function recordLogin(c: Client, role: "feed" | "admin", device: any, isSignIn: boolean) {
  const id = typeof device?.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(device.id) ? device.id : (c.ip ? "ip:" + c.ip : null);
  if (!id) return;
  const { data: prev } = await db.from("watch_devices").select("first_seen, last_seen, logins, role").eq("device_id", id).maybeSingle();
  const now = new Date();
  if (!isSignIn && prev && now.getTime() - new Date(prev.last_seen).getTime() < 5 * 60_000) return;
  await db.from("watch_devices").upsert({
    device_id: id,
    role: isSignIn ? role : (prev?.role ?? role),
    first_seen: prev?.first_seen ?? now.toISOString(),
    last_seen: now.toISOString(),
    logins: (prev?.logins ?? 0) + (isSignIn ? 1 : 0),
    ip: c.ip, country: c.country, city: c.city, asn: c.asn, user_agent: c.user_agent,
    geo: c.geo ?? null,
    client: cleanObject(device?.info),
  });
}

// A correct code resets this device's count.
async function rightCode(c: Client) {
  if (c.ip) await db.from("feed_failures").delete().eq("ip", c.ip);
}

async function matches(name: string, given: unknown): Promise<boolean> {
  const expected = env(name);
  return !!expected && typeof given === "string" && (await safeEqual(given.trim(), expected));
}

// Blocked devices and the last 24 hours of wrong codes grouped by device, for the admin page.
async function securityState(you: Client, yourDevice?: string) {
  const [{ data: bans }, { data: fails }, { data: devices }] = await Promise.all([
    db.from("watch_bans").select("ip, banned_at, failures, country, city, asn, user_agent").order("banned_at", { ascending: false }).limit(100),
    db.from("feed_failures").select("ip, country, city, asn, user_agent, created_at")
      .gte("created_at", new Date(Date.now() - 86400_000).toISOString()).order("created_at", { ascending: false }).limit(500),
    db.from("watch_devices").select("*").order("last_seen", { ascending: false }).limit(100),
  ]);
  const byIp = new Map<string, Record<string, unknown>>();
  for (const f of fails ?? []) {
    const key = f.ip ?? "unknown";
    const g = byIp.get(key);
    if (g) g.count = (g.count as number) + 1;
    else byIp.set(key, { ...f, ip: f.ip, count: 1, last: f.created_at });
  }
  return {
    bans: bans ?? [], attempts: [...byIp.values()], devices: devices ?? [],
    your_ip: you.ip, your_device: yourDevice ?? null, per_device_limit: MAX_FAILURES_PER_DEVICE_PER_DAY,
  };
}

// Trash: deleted cards and removed Telegram recipients, restorable from the admin page. Kept 30 days.
const TRASH_DAYS = 30;

async function toTrash(kind: "card" | "recipient", items: unknown[]) {
  if (!items.length) return;
  const { error } = await db.from("watch_trash").insert(items.map((data) => ({ kind, data })));
  if (error) throw new Error("trash insert failed");
  await db.from("watch_trash").delete().lt("deleted_at", new Date(Date.now() - TRASH_DAYS * 86400_000).toISOString());
}

async function listTrash() {
  const { data, error } = await db.from("watch_trash").select("id, kind, data, deleted_at").order("id", { ascending: false }).limit(100);
  if (error) throw new Error("trash read failed");
  return data;
}

async function saveRecipients(recipients: Recipient[]) {
  const { error } = await db.from("watch_settings")
    .upsert({ key: "telegram_recipients", value: recipients, updated_at: new Date().toISOString() });
  if (error) throw new Error("recipients update failed");
}

// Puts a trashed item back: cards keep their original id and time (no Telegram ping), people go to the end of the list.
async function restoreFromTrash(trashId: number): Promise<string | null> {
  const { data: item } = await db.from("watch_trash").select("id, kind, data").eq("id", trashId).maybeSingle();
  if (!item) return "not in trash";
  if (item.kind === "card") {
    const { error } = await db.from("watch_cards").upsert({ id: item.data.id, text: item.data.text, created_at: item.data.created_at });
    if (error) throw new Error("card restore failed");
  } else {
    const list = await getRecipients();
    if (list.length >= MAX_RECIPIENTS) return "recipient list is full";
    if (!list.some((r) => r.chat_id === item.data.chat_id)) await saveRecipients([...list, item.data as Recipient]);
  }
  await db.from("watch_trash").delete().eq("id", trashId);
  return null;
}

// People who messaged the bot recently (Telegram keeps updates for about 24 hours), newest first.
// Used by the admin page to find a new person's chat ID. Never returns the bot token.
async function recentBotChats() {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return { error: "TELEGRAM_BOT_TOKEN is not set" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, { signal: ctrl.signal });
    if (!res.ok) return { error: `Telegram returned HTTP ${res.status}` };
    const body = await res.json();
    const known = new Set((await getRecipients()).map((r) => r.chat_id));
    const byChat = new Map<string, Record<string, unknown>>();
    for (const u of body.result ?? []) {
      const m = u.message ?? u.edited_message;
      if (!m?.chat || m.chat.type !== "private") continue;
      const chatId = String(m.chat.id);
      const prev = byChat.get(chatId);
      if (prev && (prev.date as number) >= m.date) continue;
      byChat.set(chatId, {
        chat_id: chatId,
        name: [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" "),
        username: m.chat.username ?? null,
        date: new Date(m.date * 1000).toISOString(),
        known: known.has(chatId),
      });
    }
    return { chats: [...byChat.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))) };
  } catch (e) {
    return { error: `Telegram request failed (${e instanceof Error ? e.name : "unknown"})` };
  } finally {
    clearTimeout(timer);
  }
}

async function adminState(client: Client, yourDevice?: string) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const [settings, cards, fails, recipients, trash, security] = await Promise.all(
    [getSettings(), listCards(), recentFailures(), getRecipients(), listTrash(), securityState(client, yourDevice)]);
  return { settings, cards, recipients, trash, security, stats: { cards: cards.length, failures_last_hour: fails, max_failures_per_hour: MAX_FAILURES_PER_HOUR, since } };
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
      const client = await clientOf(req);
      const denied = await gate(client);
      if (denied) return denied;
      if (!(await getSettings()).feed_enabled) return json({ error: "feed paused" }, 403);
      if (!env("FEED_PASSCODE")) return json({ error: "disabled" }, 404);
      if (!(await matches("FEED_PASSCODE", body?.passcode))) return await wrongCode(client!);
      await rightCode(client!);
      await recordLogin(client!, "feed", body?.device, false);
      return json({ cards: await listCards() });
    }

    // The keypad: one 4-digit code decides between the admin panel and the feed.
    if (path === "/unlock" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const client = await clientOf(req);
      const denied = await gate(client);
      if (denied) return denied;
      if (await matches("ADMIN_PASSCODE", body?.passcode)) {
        await rightCode(client!);
        await recordLogin(client!, "admin", body?.device, true);
        return json({ role: "admin", ...(await adminState(client!, body?.device?.id)) });
      }
      if (await matches("FEED_PASSCODE", body?.passcode)) {
        if (!(await getSettings()).feed_enabled) return json({ error: "feed paused" }, 403);
        await rightCode(client!);
        await recordLogin(client!, "feed", body?.device, true);
        return json({ role: "feed", cards: await listCards() });
      }
      return await wrongCode(client!);
    }

    if (path === "/admin" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const client = await clientOf(req);
      const denied = await gate(client);
      if (denied) return denied;
      if (!env("ADMIN_PASSCODE")) return json({ error: "disabled" }, 404);
      if (!(await matches("ADMIN_PASSCODE", body?.passcode))) return await wrongCode(client!);
      await recordLogin(client!, "admin", body?.device, false);

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
          const { data: card } = await db.from("watch_cards").select("id, text, created_at").eq("id", body.id).maybeSingle();
          if (card) {
            await toTrash("card", [card]);
            const { error } = await db.from("watch_cards").delete().eq("id", body.id);
            if (error) throw new Error("delete failed");
          }
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
          const kept = new Set(recipients.map((r) => r.chat_id));
          await toTrash("recipient", (await getRecipients()).filter((r) => !kept.has(r.chat_id)));
          await saveRecipients(recipients);
          break;
        }
        case "restore": {
          if (!Number.isInteger(body.trash_id)) return json({ error: "trash_id must be an integer" }, 400);
          const problem = await restoreFromTrash(body.trash_id);
          if (problem) return json({ error: problem }, 400);
          break;
        }
        case "purge": {
          if (!Number.isInteger(body.trash_id)) return json({ error: "trash_id must be an integer" }, 400);
          const { error } = await db.from("watch_trash").delete().eq("id", body.trash_id);
          if (error) throw new Error("purge failed");
          break;
        }
        case "empty_trash": {
          const { error } = await db.from("watch_trash").delete().gte("id", 0);
          if (error) throw new Error("empty trash failed");
          break;
        }
        case "find_chats":
          return json({ ...(await adminState(client!, body?.device?.id)), found: await recentBotChats() });
        case "unblock": {
          if (typeof body.ip !== "string" || !body.ip) return json({ error: "ip required" }, 400);
          await db.from("watch_bans").delete().eq("ip", body.ip);
          await db.from("feed_failures").delete().eq("ip", body.ip);
          break;
        }
        case "block": {
          if (typeof body.ip !== "string" || !body.ip) return json({ error: "ip required" }, 400);
          if (body.ip === client!.ip) return json({ error: "that's your own device" }, 400);
          const { data: lastFail } = await db.from("feed_failures").select("country, city, asn, user_agent")
            .eq("ip", body.ip).order("created_at", { ascending: false }).limit(1).maybeSingle();
          const { data: lastDevice } = lastFail ? { data: null } : await db.from("watch_devices").select("country, city, asn, user_agent")
            .eq("ip", body.ip).order("last_seen", { ascending: false }).limit(1).maybeSingle();
          const last = lastFail ?? lastDevice;
          const { count } = await db.from("feed_failures").select("id", { count: "exact", head: true }).eq("ip", body.ip);
          await db.from("watch_bans").upsert({ ip: body.ip, failures: count ?? 0, ...(last ?? {}), banned_at: new Date().toISOString() });
          break;
        }
        case "forget_device": {
          if (typeof body.device_id !== "string" || !body.device_id) return json({ error: "device_id required" }, 400);
          await db.from("watch_devices").delete().eq("device_id", body.device_id);
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
      return json(await adminState(client!, body?.device?.id));
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
