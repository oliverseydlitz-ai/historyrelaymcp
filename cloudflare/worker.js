// Paste into a Cloudflare Worker (dashboard editor). Forwards everything to the Supabase edge function.
const TARGET = "https://jdmahrrxtxqrcpcwmwvx.supabase.co/functions/v1/watch";

export default {
  async fetch(request) {
    const u = new URL(request.url);
    return fetch(new Request(TARGET + u.pathname + u.search, request));
  },
};
