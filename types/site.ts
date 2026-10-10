// The shape of site.config.js (docs/SELF_HOSTING.md).
export type Environment = "production" | "test";

export type SiteConfig = {
  owner: { login: string; twitchId: string };
  builtinChannels: string[];
  defaultChannel: string;
  workers: Record<Environment, string>;
  origins: Record<Environment, string>;
  channelDomains: Record<Environment, Record<string, string>>;
  bot: Partial<Record<Environment, string>>;
};
