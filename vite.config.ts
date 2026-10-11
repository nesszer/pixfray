import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import site from "./site.config.js";
import { linkServed, servedSources, servedVersion, stripServed } from "./scripts/lib/served.ts";
// Multi-page build: index.html (viewer dashboard: /?channel= and the /play/ picker), "/admin/", "/admin/dev/", "/start/" (streamer sign-up),
// intro/index.html (3D showcase, served at "/" by server/worker.ts page()).
// Add new pages here as extra inputs; files in public/ are copied as-is.
// The pages' HTML names the site through tokens filled in from site.config.js, so a copy of PixFray needs no HTML edits:
// %SITE_CHANNEL% (default channel), %SITE_OWNER% (owner login), %SITE_ORIGIN%, %SITE_HOST% and %SITE_TEST_ORIGIN% (production and test sites).
const SITE_TOKENS = {
  SITE_CHANNEL: site.defaultChannel,
  SITE_OWNER: site.owner.login,
  SITE_ORIGIN: site.origins.production,
  SITE_HOST: new URL(site.origins.production).host,
  SITE_TEST_ORIGIN: site.origins.test,
};
const siteTokens = {
  name: "site-tokens",
  transformIndexHtml: {
    order: "pre",
    handler: (html) => html.replace(/%(SITE_[A-Z_]+)%/g, (m, k: keyof typeof SITE_TOKENS) => SITE_TOKENS[k] ?? m),
  },
} satisfies Plugin;
// The overlay and the other modules loaded by a fixed URL (/overlay.js, /hats.js, /upload.js, ...) live in src/served/
// as .js or .ts and are served as plain JavaScript at the site root under the same names (scripts/lib/served.ts).
// Their URLs never change between deploys and OBS's browser keeps running cached code after a reload, so the build
// adds ?v=<hash of the served code> to every reference between them and in public/*.html, and each deploy with new
// overlay code loads fresh modules. The dev server serves them unversioned and uncached, so an edit shows on reload.
const servedDev = {
  name: "served-modules-dev",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const name = /^\/([\w-]+)\.js(?:\?|$)/.exec(req.url || "")?.[1];
      const modules = servedSources(),
        module = modules.find((m) => m.name === name);
      if (!module) return next();
      try {
        const code = await stripServed(module.file, readFileSync(module.file, "utf8"));
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(
          linkServed(
            code,
            modules.map((m) => m.name),
            "",
          ),
        );
      } catch (error) {
        next(error);
      }
    });
  },
} satisfies Plugin;
const servedBuild = {
  name: "served-modules",
  apply: "build",
  async closeBundle() {
    if (this.environment && this.environment.name !== "client") return;
    const out = this.environment ? this.environment.config.build.outDir : "dist";
    if (!existsSync(out)) throw new Error(`served-modules: build output ${out} is missing`);
    const modules = await Promise.all(
      servedSources().map(async ({ name, file }) => ({
        name,
        code: await stripServed(file, readFileSync(file, "utf8")),
      })),
    );
    const names = modules.map((m) => m.name),
      v = servedVersion(modules);
    for (const { name, code } of modules) writeFileSync(join(out, name + ".js"), linkServed(code, names, v));
    for (const f of readdirSync("public").filter((f) => f.endsWith(".html"))) {
      const file = join(out, f);
      writeFileSync(file, linkServed(readFileSync(file, "utf8"), names, v));
    }
  },
} satisfies Plugin;
export default defineConfig({
  // MINI_PERSIST points local DO/KV state at another folder (tests/e2e use .cloudflare/e2e-state so they never share a dev server's state).
  plugins: [
    siteTokens,
    servedDev,
    servedBuild,
    cloudflare(process.env.MINI_PERSIST ? { persistState: { path: process.env.MINI_PERSIST } } : {}),
  ],
  // Hashed bundles go to /assets/build/, which public/_headers caches for a year; public/assets/ (sprites, characters.json)
  // keeps fixed names, so it stays revalidated.
  environments: {
    client: {
      build: {
        assetsDir: "assets/build",
        rollupOptions: {
          input: {
            main: "index.html",
            admin: "admin/index.html",
            dev: "admin/dev/index.html",
            start: "start/index.html",
            intro: "intro/index.html",
          },
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: Number(process.env.MINI_PORT) || 5173, strictPort: true },
});
