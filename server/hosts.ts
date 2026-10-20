import { parseChannelOrigins } from "./parse.ts";
import type { Env } from "./env.ts";

/** The bindings these helpers read. */
type HostEnv = Pick<Env, "CHANNEL_ORIGINS" | "PUBLIC_ORIGIN">;

// Channel domains serve only the channel configured for each domain.
// CHANNEL_ORIGINS is JSON {channel: origin}. On such a domain the viewer and mod pages open that channel, and pages
// for any other channel move to PUBLIC_ORIGIN (the main site). The API, the overlay and the assets answer on every
// domain, so older OBS and StreamElements links keep working.
// Anything but a JSON object of URLs is no channel domains.
export function channelOrigins(env: Pick<Env, "CHANNEL_ORIGINS">): Record<string, string> {
  const origins = parseChannelOrigins(env.CHANNEL_ORIGINS || "{}");
  return origins.ok ? origins.value : {};
}
// The channel whose own domain this request came in on, or ''.
export function hostChannel(env: HostEnv, url: URL): string {
  return Object.entries(channelOrigins(env)).find(([, origin]) => origin === url.origin)?.[0] || "";
}
// Where links for a channel point: its own domain if it has one, else the main site.
export function siteOrigin(env: HostEnv, url: URL, channel: string): string {
  return channelOrigins(env)[channel] || env.PUBLIC_ORIGIN || url.origin;
}
// Sign-in returns to the domain it started on (cookies are per domain), when that domain is one of ours.
export function authOrigin(env: HostEnv, url: URL): string {
  return hostChannel(env, url) ? url.origin : env.PUBLIC_ORIGIN || url.origin;
}
// The home, picker, mod, signup and changelog pages (the paths cloudflare.config.ts sends through the Worker; /intro/ only redirects).
export const isPage = (path: string): boolean => /^\/(index\.html)?$|^\/(admin|start|play|changelog)(\/|$)/.test(path);
// Page requests on a channel domain: other channels and the site-wide pages (/start, /play, /changelog, /admin/dev) move to the main
// site; a page without ?channel= gets the domain's channel. 302, so a later change is not stuck in browser caches.
export function channelPageRedirect(env: HostEnv, url: URL): Response | null {
  const channel = hostChannel(env, url),
    path = url.pathname;
  if (!channel || !isPage(path)) return null;
  const asked = (url.searchParams.get("channel") || "").toLowerCase();
  if (env.PUBLIC_ORIGIN && (/^\/(start|play|changelog|admin\/dev)(\/|$)/.test(path) || (asked && asked !== channel)))
    return Response.redirect(env.PUBLIC_ORIGIN + path + url.search + url.hash, 302);
  if (!asked && !/^\/(start|play|changelog|admin\/dev)(\/|$)/.test(path)) {
    const to = new URL(url);
    to.searchParams.set("channel", channel);
    return Response.redirect(to.href, 302);
  }
  return null;
}
