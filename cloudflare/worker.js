// Serves the feed page at "/" and forwards everything else to the Supabase edge function.
// (Supabase rewrites text/html from functions to text/plain, so the page has to come from here.)
import page from "./index.html";

const TARGET = "https://jdmahrrxtxqrcpcwmwvx.supabase.co/functions/v1/watch";

// Header values must be Latin-1, so city/ISP names (e.g. "Plzeň") are URI-encoded.
const enc = (v) => (v ? encodeURIComponent(String(v)) : "");

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }

    // Tell the function who is really calling, so it can block devices that guess passcodes.
    // PROXY_SECRET (a Worker secret, same value as the Supabase secret) proves these headers came from here.
    const headers = new Headers(request.headers);
    for (const h of ["x-watch-proxy-key", "x-watch-client-ip", "x-watch-country", "x-watch-city", "x-watch-asorg"]) headers.delete(h);
    if (env && env.PROXY_SECRET) {
      headers.set("x-watch-proxy-key", env.PROXY_SECRET);
      headers.set("x-watch-client-ip", request.headers.get("cf-connecting-ip") || "");
      headers.set("x-watch-country", enc(request.cf && request.cf.country));
      headers.set("x-watch-city", enc(request.cf && request.cf.city));
      headers.set("x-watch-asorg", enc(request.cf && request.cf.asOrganization));
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return fetch(TARGET + u.pathname + u.search, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    });
  },
};
