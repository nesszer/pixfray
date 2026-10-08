// Security headers: the Worker adds them to every response it returns (server/worker.js), and public/_headers repeats
// the same policies for the files assets serve without the Worker (/overlay.html); tests/security.test.mjs keeps both in step.
// No inline script runs anywhere (every page loads <script type="module" src>), so script-src is 'self' (pages add Cloudflare's analytics beacon): no hashes,
// no 'unsafe-inline', no 'wasm-unsafe-eval' (three.js uses WebGL only). Inline JSON-LD would not be executed, so it needs nothing.
export const HSTS = "max-age=31536000; includeSubDomains";
// style-src keeps 'unsafe-inline': overlay.html has an inline <style>, and intro/main.js writes style="--i:n" attributes.
// img/media blob: and data: cover canvas textures and Vite-inlined assets; connect 'self' covers fetch and the same-origin WebSocket.
const BASE = [
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
];
// Pages (/ with the intro or a fighter page, /play, /admin, /start): no framing by other sites. The start page frames /overlay.html, which is same-origin.
// Cloudflare's edge adds its Web Analytics beacon to every page; pages allow its script and report URL, the overlay doesn't
// (OBS sources would only count as visits).
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  ...BASE,
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
].join("; ");
// The OBS overlay: public/chat.js reads Twitch chat over IRC (wss), and the page stays frameable (the start page demo embeds it).
export const OVERLAY_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  ...BASE,
  "connect-src 'self' wss://irc-ws.chat.twitch.tv",
].join("; ");
// JSON, images and plain-text replies from /api and /auth: nothing may load or run, and nothing may frame them.
export const API_CSP = "default-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// A copy of the response with the headers added (Worker, Durable Object and redirect responses have immutable headers).
// csp: the policy for this response, or '' for none. WebSocket upgrades pass through untouched.
export function secure(response, url, csp = "") {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  if (url.protocol === "https:") out.headers.set("Strict-Transport-Security", HSTS);
  if (csp && !out.headers.has("Content-Security-Policy")) out.headers.set("Content-Security-Policy", csp);
  return out;
}
