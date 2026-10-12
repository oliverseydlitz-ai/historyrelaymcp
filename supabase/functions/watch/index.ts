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

// Best-effort Telegram ping; never throws, never logs the token.
async function notifyTelegram(id: number) {
  const token = env("TELEGRAM_BOT_TOKEN"), chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `Watch card #${id}` }),
      signal: ctrl.signal,
    });
    if (!res.ok) console.error(`telegram sendMessage failed: HTTP ${res.status}`);
  } catch (e) {
    console.error(`telegram sendMessage failed: ${e instanceof Error ? e.name : "unknown error"}`);
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
  await notifyTelegram(data.id as number);
  return { id: data.id as number, created_at: data.created_at as string };
}

async function latestCard() {
  const { data, error } = await db
    .from("watch_cards").select("id, text, created_at").order("id", { ascending: false }).limit(1);
  if (error) throw new Error("read failed");
  return data[0] ?? null;
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
    if (path === "/health" && req.method === "GET") return json({ ok: true });

    if (path === "/card" && req.method === "POST") {
      if (!(await authorized(req, env("WRITE_TOKEN")))) return new Response(null, { status: 401, headers: HEADERS });
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const text = validateText(body?.text);
      if (text === null) return json({ error: "text must be a non-empty string of at most 1000 characters" }, 400);
      return json(await insertCard(text));
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
