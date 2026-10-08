import { defineConfig, defineWorker, bindings, exports } from "cf/config";
import { readFileSync } from "node:fs";
// site.config.js is read as text, not imported: under cf dev the Worker can't load a file this config process has loaded.
const site = (await import("data:text/javascript," + encodeURIComponent(readFileSync("site.config.js", "utf8"))))
  .default;
export default defineConfig(({ mode }) => {
  const testing = mode === "test";
  const environment = testing ? "test" : "production";
  const name = site.workers[environment];
  // MINI_LOCAL_TEST=1 is only for `cf dev` in scripts/test-all.mjs: chat can then be marked connected without Twitch,
  // and PUBLIC_ORIGIN is the loopback dev server. It can never reach a build or a deploy.
  const localTest = process.env.MINI_LOCAL_TEST === "1";
  if (localTest && (testing || process.argv.some((a) => /^(build|deploy|publish|versions)$/.test(a))))
    throw new Error("MINI_LOCAL_TEST is only allowed with cf dev");
  const origin = localTest ? "http://127.0.0.1:" + (Number(process.env.MINI_PORT) || 5173) : site.origins[environment];
  // Channel domains open their configured channel, and pages for other channels move to the main site.
  // The API and the overlay still answer there, so older OBS and StreamElements links keep working (server/hosts.js).
  const channelDomains = site.channelDomains[environment] || {};
  const channelOrigins = Object.fromEntries(
    Object.entries(channelDomains).map(([channel, domain]) => [channel, "https://" + domain]),
  );
  const bot = localTest || process.argv.includes("dev") ? "" : site.bot[environment]; // no chat bot on a local server
  return {
    worker: defineWorker({
      name,
      compatibilityDate: "2026-09-25",
      entrypoint: "./server/worker.js",
      domains: [new URL(origin).hostname, ...Object.values(channelDomains)],
      // The pages go through the Worker too, so a channel domain can send other channels' pages to the main site.
      assets: {
        runWorkerFirst: [
          "/api/*",
          "/auth/*",
          "/",
          "/index.html",
          "/admin",
          "/admin/*",
          "/start",
          "/start/*",
          "/play",
          "/play/*",
          "/intro",
          "/intro/*",
          "/robots.txt",
          "/sitemap.xml",
        ],
        notFoundHandling: "404-page",
      },
      // Workers Logs: console output and requests, kept by Cloudflare (dashboard: Workers > this worker > Logs).
      // redactQueryString keeps StreamElements keys (?k=...) out of the stored request URLs.
      observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true } },
      exports: {
        ChannelRoom: exports.durableObject({ storage: "sqlite" }),
        AuthStore: exports.durableObject({ storage: "sqlite" }),
      },
      env: {
        ASSETS: bindings.assets(),
        ROOMS: bindings.durableObject({ worker: name, exportName: "ChannelRoom" }),
        AUTH: bindings.durableObject({ worker: name, exportName: "AuthStore" }),
        AUTH_SECRET: bindings.secret(),
        INTERNAL_SECRET: bindings.secret(),
        TWITCH_CLIENT_ID: bindings.secret(),
        TWITCH_CLIENT_SECRET: bindings.secret(),
        // Live-fix (/admin/dev): current version id. GITHUB_TOKEN, GITHUB_REPO, CF_API_TOKEN and CF_ACCOUNT_ID are optional
        // and set with `wrangler secret put` once the repo exists; declaring them here would make them required (docs/LIVE_FIX.md).
        CF_VERSION_METADATA: bindings.versionMetadata(),
        PUBLIC_ORIGIN: bindings.text(origin),
        ...(localTest ? {} : { CHANNEL_ORIGINS: bindings.text(JSON.stringify(channelOrigins)) }),
        // The configured owner's Twitch user id (public, not a secret): owner access no longer depends on the owner record,
        // which expires 90 days after the last sign-in. Sign-in still refreshes that record. Not declared for the local
        // test server, whose seeded sessions use their own owner id (tests/seed-local.mjs).
        ...(localTest ? {} : { OWNER_TWITCH_ID: bindings.text(site.owner.twitchId) }),
        // Test site only: owner access for scripts/devtools.mjs (docs/DEVTOOLS.md). Production never declares it.
        ...(testing ? { DEV_TOOLS_TOKEN: bindings.secret() } : {}),
        // When configured, the PixFray bot reads and answers chat as BOT_LOGIN (signed in once at /auth/login?bot=1).
        // BOT_DEBUG: on test, the bot also plays (sparring partner, !fray spar, !fray e2e; server/channel.js botDebug).
        ...(bot
          ? {
              CHAT_BOT: bindings.text("1"),
              BOT_LOGIN: bindings.text(bot),
              ...(testing ? { BOT_DEBUG: bindings.text("1") } : {}),
            }
          : {}),
        // Workers AI for the optional sprite redraw (server/sprites.js); a local server goes without it.
        ...(localTest || process.argv.includes("dev") ? {} : { AI: bindings.ai() }),
        ...(localTest ? { MINI_LOCAL_TEST: bindings.text("1") } : {}),
      },
    }),
  };
});
