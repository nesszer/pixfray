// @ts-check
// One place to run your own copy of PixFray: who owns the site, which channels are built in, and where it deploys.
// cloudflare.config.ts, the Worker (server/) and the pages (src/) all read it. docs/SELF_HOSTING.md walks through it.
/** @type {import("./types/site.ts").SiteConfig} */
export default {
  owner: { login: "nesszerra", twitchId: "445610108" }, // the only account that opens /admin/dev
  builtinChannels: ["nesszerra", "miolafff"], // always on; others sign up on /start
  defaultChannel: "nesszerra", // used when a URL names no channel; the only channel that may use the broadcaster EventSub connect=1 flow
  workers: { production: "nesszerra-mini-chat", test: "nesszerra-mini-chat-test" }, // Durable Object data is tied to these names
  origins: { production: "https://pixfray.xyz", test: "https://staging.pixfray.xyz" },
  channelDomains: { production: {}, test: {} }, // miolafff moved to pixfray.xyz; the old chat.miolaf.xyz Workers were deleted on 2026-10-08
  bot: { production: "pixfray", test: "pixfray" }, // PixFray chat bot account per environment (CHAT_BOT); omit an env to keep the bot off there
};
