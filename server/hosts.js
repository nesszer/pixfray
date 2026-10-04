// Channel domains: a streamer's own domain that serves only their channel (chat.miolaf.xyz is miolafff's).
// CHANNEL_ORIGINS is JSON {channel: origin}. On such a domain the viewer and mod pages open that channel, and pages
// for any other channel move to PUBLIC_ORIGIN (the main site). The API, the overlay and the assets answer on every
// domain, so older OBS and StreamElements links keep working.
export function channelOrigins(env) {
  try {
    const all = JSON.parse(env.CHANNEL_ORIGINS || '{}'), out = {};
    for (const [channel, origin] of Object.entries(all && typeof all === 'object' ? all : {})) out[channel] = new URL(origin).origin;
    return out;
  } catch { return {}; }
}
// The channel whose own domain this request came in on, or ''.
export function hostChannel(env, url) {
  return Object.entries(channelOrigins(env)).find(([, origin]) => origin === url.origin)?.[0] || '';
}
// Where links for a channel point: its own domain if it has one, else the main site.
export function siteOrigin(env, url, channel) {
  return channelOrigins(env)[channel] || env.PUBLIC_ORIGIN || url.origin;
}
// Sign-in returns to the domain it started on (cookies are per domain), when that domain is one of ours.
export function authOrigin(env, url) {
  return hostChannel(env, url) ? url.origin : env.PUBLIC_ORIGIN || url.origin;
}
// The viewer, mod and signup pages (the paths cloudflare.config.ts sends through the Worker).
export const isPage = (path) => /^\/(index\.html)?$|^\/(admin|start)(\/|$)/.test(path);
// Page requests on a channel domain: other channels and the site-wide pages (/start, /admin/dev) move to the main
// site; a page without ?channel= gets the domain's channel. 302, so a later change is not stuck in browser caches.
export function channelPageRedirect(env, url) {
  const channel = hostChannel(env, url), path = url.pathname;
  if (!channel || !isPage(path)) return null;
  const asked = (url.searchParams.get('channel') || '').toLowerCase();
  if (env.PUBLIC_ORIGIN && (/^\/(start|admin\/dev)(\/|$)/.test(path) || (asked && asked !== channel)))
    return Response.redirect(env.PUBLIC_ORIGIN + path + url.search + url.hash, 302);
  if (!asked && !/^\/(start|admin\/dev)(\/|$)/.test(path)) {
    const to = new URL(url);
    to.searchParams.set('channel', channel);
    return Response.redirect(to.href, 302);
  }
  return null;
}
