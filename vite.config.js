import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
// Multi-page build: "/" (viewer dashboard, Lane B), "/admin/" (Lane B), "/admin/dev/" (Lane E), "/start/" (streamer invites).
// Add new pages here as extra inputs; files in public/ are copied as-is.
export default defineConfig({
  // MINI_PERSIST points local DO/KV state at another folder (tests/e2e use .cloudflare/e2e-state so they never share a dev server's state).
  plugins: [cloudflare(process.env.MINI_PERSIST ? { persistState: { path: process.env.MINI_PERSIST } } : {})],
  environments: { client: { build: { rollupOptions: { input: { main: "index.html", admin: "admin/index.html", dev: "admin/dev/index.html", start: "start/index.html" } } } } },
  server: { host: "127.0.0.1", port: Number(process.env.MINI_PORT) || 5173, strictPort: true }
});
