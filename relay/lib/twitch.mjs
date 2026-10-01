import { REQUIRED_CHAT_SCOPE, USER_AGENT, createChatSubscription } from './core.mjs';

export const TWITCH_ID_BASE = 'https://id.twitch.tv';
export const TWITCH_HELIX_BASE = 'https://api.twitch.tv/helix';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class TwitchAuthError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'TwitchAuthError';
    this.status = status;
  }
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function form(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value) body.set(key, value);
  return body;
}

function tokenRecord(data, now) {
  if (!data?.access_token || !data?.refresh_token) throw new TwitchAuthError('Twitch returned no token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scopes: Array.isArray(data.scope) ? data.scope : [],
    expiresAt: now + (Number(data.expires_in) || 0) * 1000,
  };
}

// Device code grant (works for Public and Confidential Twitch apps; no redirect URL needed).
export async function deviceCodeLogin({
  clientId, clientSecret = '', scopes = [REQUIRED_CHAT_SCOPE], fetch = globalThis.fetch, idBase = TWITCH_ID_BASE,
  onPrompt = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
}) {
  if (!clientId) throw new TwitchAuthError('A Twitch client ID is required');
  const scope = scopes.join(' ');
  const start = await fetch(idBase + '/oauth2/device', { method: 'POST', headers: { 'User-Agent': USER_AGENT }, body: form({ client_id: clientId, scopes: scope }) });
  const device = await readJson(start);
  if (!start.ok || !device?.device_code) throw new TwitchAuthError('Twitch refused the device login (' + start.status + ')', start.status);
  onPrompt({ verificationUri: device.verification_uri, userCode: device.user_code, expiresIn: device.expires_in });

  let interval = Math.max(1, Number(device.interval) || 5) * 1000;
  const deadline = now() + (Number(device.expires_in) || 1800) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    const response = await fetch(idBase + '/oauth2/token', {
      method: 'POST', headers: { 'User-Agent': USER_AGENT },
      body: form({ client_id: clientId, client_secret: clientSecret, scopes: scope, device_code: device.device_code, grant_type: DEVICE_GRANT }),
    });
    const data = await readJson(response);
    if (response.ok) return tokenRecord(data, now());
    const message = String(data?.message ?? '');
    if (message === 'authorization_pending') continue;
    if (message === 'slow_down') { interval += 5000; continue; }
    throw new TwitchAuthError('Twitch device login failed: ' + (message || response.status), response.status);
  }
  throw new TwitchAuthError('Twitch device login expired; run "login" again');
}

export async function refreshAccessToken({ clientId, clientSecret = '', refreshToken, fetch = globalThis.fetch, idBase = TWITCH_ID_BASE, now = Date.now }) {
  const response = await fetch(idBase + '/oauth2/token', {
    method: 'POST', headers: { 'User-Agent': USER_AGENT },
    body: form({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new TwitchAuthError('Twitch token refresh failed (' + response.status + '); run "login" again', response.status);
  return tokenRecord(data, now());
}

// Returns {clientId, login, userId, scopes, expiresIn} or null when the token is invalid.
export async function validateToken({ accessToken, fetch = globalThis.fetch, idBase = TWITCH_ID_BASE }) {
  const response = await fetch(idBase + '/oauth2/validate', { headers: { Authorization: 'OAuth ' + accessToken, 'User-Agent': USER_AGENT } });
  if (response.status === 401) return null;
  const data = await readJson(response);
  if (!response.ok || !data?.user_id) throw new TwitchAuthError('Twitch token validation failed (' + response.status + ')', response.status);
  return { clientId: data.client_id, login: data.login, userId: String(data.user_id), scopes: data.scopes || [], expiresIn: Number(data.expires_in) || 0 };
}

function helixHeaders(clientId, accessToken, json = false) {
  const headers = { 'Client-Id': clientId, Authorization: 'Bearer ' + accessToken, 'User-Agent': USER_AGENT };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export async function getUserId({ clientId, accessToken, login, fetch = globalThis.fetch, helixBase = TWITCH_HELIX_BASE }) {
  const response = await fetch(helixBase + '/users?login=' + encodeURIComponent(login), { headers: helixHeaders(clientId, accessToken) });
  if (response.status === 401) throw new TwitchAuthError('Twitch token rejected', 401);
  const data = await readJson(response);
  const id = data?.data?.[0]?.id;
  if (!response.ok || !id) throw new TwitchAuthError('Twitch user lookup failed (' + response.status + ')', response.status);
  return String(id);
}

// Subscribes this EventSub WebSocket session to channel.chat.message. 409 (already exists) is fine.
export async function subscribeChat({ clientId, accessToken, sessionId, broadcasterUserId, readerUserId, fetch = globalThis.fetch, helixBase = TWITCH_HELIX_BASE }) {
  const response = await fetch(helixBase + '/eventsub/subscriptions', {
    method: 'POST', headers: helixHeaders(clientId, accessToken, true),
    body: JSON.stringify(createChatSubscription(sessionId, broadcasterUserId, readerUserId)),
  });
  if (response.ok || response.status === 409) return { ok: true, status: response.status };
  const data = await readJson(response);
  throw new TwitchAuthError('EventSub subscription failed (' + response.status + '): ' + String(data?.message ?? ''), response.status);
}
