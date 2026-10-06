import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import site from "./site.config.js";
// Multi-page build: "/" (viewer dashboard, Lane B), "/admin/" (Lane B), "/admin/dev/" (Lane E), "/start/" (streamer sign-up), "/intro/" (3D showcase).
// Add new pages here as extra inputs; files in public/ are copied as-is.
// The pages' HTML names the site through tokens filled in from site.config.js, so a copy of PixFray needs no HTML edits:
// %SITE_CHANNEL% (default channel), %SITE_OWNER% (owner login), %SITE_ORIGIN%, %SITE_HOST% and %SITE_TEST_ORIGIN% (production and test sites).
const SITE_TOKENS = { SITE_CHANNEL: site.defaultChannel, SITE_OWNER: site.owner.login, SITE_ORIGIN: site.origins.production, SITE_HOST: new URL(site.origins.production).host, SITE_TEST_ORIGIN: site.origins.test };
const siteTokens = { name: "site-tokens", transformIndexHtml: { order: "pre", handler: (html) => html.replace(/%(SITE_[A-Z_]+)%/g, (m, k) => SITE_TOKENS[k] ?? m) } };
export default defineConfig({
  // MINI_PERSIST points local DO/KV state at another folder (tests/e2e use .cloudflare/e2e-state so they never share a dev server's state).
  plugins: [siteTokens, cloudflare(process.env.MINI_PERSIST ? { persistState: { path: process.env.MINI_PERSIST } } : {})],
  environments: { client: { build: { rollupOptions: { input: { main: "index.html", admin: "admin/index.html", dev: "admin/dev/index.html", start: "start/index.html", intro: "intro/index.html" } } } } },
  server: { host: "127.0.0.1", port: Number(process.env.MINI_PORT) || 5173, strictPort: true }
});
