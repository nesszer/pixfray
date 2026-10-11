// The Worker's bindings, as cloudflare.config.ts declares them (types only). Bindings that config adds only for some
// modes (production, test, local dev) are optional, and so are the live-fix secrets set by hand (docs/LIVE_FIX.md).
export type Env = {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  AUTH: DurableObjectNamespace;
  BACKUPS?: D1Database; // not on a local server
  AI?: Ai; // not on a local server
  AUTH_SECRET: string;
  INTERNAL_SECRET: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  PUBLIC_ORIGIN: string;
  CHANNEL_ORIGINS?: string; // JSON: channel -> https origin
  OWNER_TWITCH_ID?: string;
  DEV_TOOLS_TOKEN?: string; // test site only
  CHAT_BOT?: string; // "1" when the PixFray bot is configured
  BOT_LOGIN?: string;
  BOT_DEBUG?: string; // test site only
  MINI_LOCAL_TEST?: string; // cf dev under scripts/test-all.ts only
  SE_ONLY?: string; // test site: chat comes only from StreamElements
  CHANNEL_NAME?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_BASE_BRANCH?: string;
  GITHUB_WORKFLOW?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
};
