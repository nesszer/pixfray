import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import site from "./site.config.js";
// Multi-page build: "/" (viewer dashboard, Lane B), "/admin/" (Lane B), "/admin/dev/" (Lane E), "/start/" (streamer sign-up), "/intro/" (3D showcase).
// Add new pages here as extra inputs; files in public/ are copied as-is.
// The pages' HTML names the site through tokens filled in from site.config.js, so a copy of PixFray needs no HTML edits:
// %SITE_CHANNEL% (default channel), %SITE_OWNER% (owner login), %SITE_ORIGIN%, %SITE_HOST% and %SITE_TEST_ORIGIN% (production and test sites).
const SITE_TOKENS = { SITE_CHANNEL: site.defaultChannel, SITE_OWNER: site.owner.login, SITE_ORIGIN: site.origins.production, SITE_HOST: new URL(site.origins.production).host, SITE_TEST_ORIGIN: site.origins.test };
const siteTokens = { name: "site-tokens", transformIndexHtml: { order: "pre", handler: (html) => html.replace(/%(SITE_[A-Z_]+)%/g, (m, k) => SITE_TOKENS[k] ?? m) } };
// public/ is copied as-is, so the overlay's module URLs (./overlay.js, ./cosmetics.js, ...) never change between deploys
// and OBS's browser keeps running cached code after a reload. The build adds ?v=<hash of public/*.js> to every
// "./x.js" reference in the copied .html and .js files, so each deploy loads fresh modules. The dev server is unchanged.
const versionPublicModules = {
  name: "version-public-modules", apply: "build",
  closeBundle() {
    if (this.environment && this.environment.name !== "client") return;
    const out = this.environment ? this.environment.config.build.outDir : "dist", js = readdirSync("public").filter((f) => f.endsWith(".js")).sort();
    const hash = createHash("sha256"); for (const f of js) hash.update(f).update(readFileSync(join("public", f)));
    const v = hash.digest("hex").slice(0, 10);
    for (const f of readdirSync("public").filter((f) => /\.(js|html)$/.test(f))) {
      const file = join(out, f), text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace(/(["'])\.\/([\w-]+\.js)\1/g, (m, q, name) => (js.includes(name) ? `${q}./${name}?v=${v}${q}` : m)));
    }
  }
};
export default defineConfig({
  // MINI_PERSIST points local DO/KV state at another folder (tests/e2e use .cloudflare/e2e-state so they never share a dev server's state).
  plugins: [siteTokens, versionPublicModules, cloudflare(process.env.MINI_PERSIST ? { persistState: { path: process.env.MINI_PERSIST } } : {})],
  environments: { client: { build: { rollupOptions: { input: { main: "index.html", admin: "admin/index.html", dev: "admin/dev/index.html", start: "start/index.html", intro: "intro/index.html" } } } } },
  server: { host: "127.0.0.1", port: Number(process.env.MINI_PORT) || 5173, strictPort: true }
});
