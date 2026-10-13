// Serves the feed page at "/" and forwards everything else to the Supabase edge function.
// (Supabase rewrites text/html from functions to text/plain, so the page has to come from here.)
import page from "./index.html";

const TARGET = "https://jdmahrrxtxqrcpcwmwvx.supabase.co/functions/v1/watch";

export default {
  async fetch(request) {
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
    return fetch(new Request(TARGET + u.pathname + u.search, request));
  },
};
