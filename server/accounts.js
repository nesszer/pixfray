import { appToken } from "./eventsub.js";

// When a Twitch account was made (ms), from Helix with the app token; 0 when Twitch doesn't know the id. Throws when
// Twitch can't be asked (not configured, or the request failed), so the caller can try again later.
export async function accountCreatedAt(env, userId) {
  if (!env?.TWITCH_CLIENT_ID || !env?.TWITCH_CLIENT_SECRET) throw new Error("twitch_not_configured");
  const call = async (token) => fetch("https://api.twitch.tv/helix/users?id=" + encodeURIComponent(userId), { headers: { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + token } });
  let r = await call(await appToken(env));
  if (r.status === 401) r = await call(await appToken(env, true));
  if (!r.ok) throw new Error("helix_users_" + r.status);
  const user = (await r.json()).data?.[0];
  return user ? Date.parse(user.created_at) || 0 : 0;
}
