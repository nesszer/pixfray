import { EventEmitter } from 'node:events';
import { BackendClient } from './backend.mjs';
import { CHANNEL_LOGIN, EVENTSUB_URL, REQUIRED_CHAT_SCOPE, backendSocketUrl, backoffDelay, parseEventSubMessage, routeChatMessage } from './core.mjs';
import { EventSubClient } from './eventsub.mjs';
import { TWITCH_HELIX_BASE, TWITCH_ID_BASE, TwitchAuthError, getUserId, refreshAccessToken, subscribeChat, validateToken } from './twitch.mjs';

// Auth problems need a new login; anything else (network, Twitch 5xx) is retried.
export const isAuthError = (error) => error instanceof TwitchAuthError && [0, 400, 401, 403].includes(error.status);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VALIDATE_EVERY_MS = 60 * 60_000; // Twitch asks apps to validate tokens hourly.
const REFRESH_MARGIN_MS = 5 * 60_000;

// Runs the relay: Twitch EventSub in, one Worker WebSocket out.
// Events: status {component, event}, forwarded event, ack, fatal {reason, message}.
export class Relay extends EventEmitter {
  constructor({
    config, persist = async () => {}, fetch = globalThis.fetch, WebSocket,
    eventsubUrl = EVENTSUB_URL, idBase = TWITCH_ID_BASE, helixBase = TWITCH_HELIX_BASE,
    random = Math.random, baseMs = 1_000, maxMs = 60_000, twitchGraceMs = 15_000, now = Date.now,
  }) {
    super();
    if (!config?.backend) throw new Error('Relay is not paired; run "pair <code>" first');
    if (!config?.twitch) throw new Error('Twitch is not linked; run "login" first');
    Object.assign(this, { config, persist, fetch, WebSocket, eventsubUrl, idBase, helixBase, random, baseMs, maxMs, twitchGraceMs, now });
    this.channel = config.backend.channel || CHANNEL_LOGIN;
    this.lastPresence = new Map();
    this.twitchUp = false;
    this.twitchDownSince = 0;
    this.refreshing = null;
    this.validateTimer = null;
    this.stopped = false;
  }

  status(component, event) { this.emit('status', { component, event }); }

  fail(reason, message) {
    if (this.stopped) return;
    this.emit('fatal', { reason, message });
    this.stop({ offline: true }).catch(() => {});
  }

  // Twitch is reported down to the Worker only after a grace period, so a quick EventSub
  // reconnect does not cancel running duels.
  twitchConnected() {
    if (this.twitchUp) return true;
    return this.twitchDownSince > 0 && this.now() - this.twitchDownSince < this.twitchGraceMs;
  }

  setTwitch(up) {
    if (up === this.twitchUp) return;
    this.twitchUp = up;
    this.twitchDownSince = up ? 0 : this.now();
    this.status('twitch', up ? 'connected' : 'disconnected');
    if (up) {
      if (!this.backendStarted) { this.backendStarted = true; this.backend.start(); }
      else this.backend.notifyTwitch(true);
    }
  }

  async refreshToken() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const t = this.config.twitch;
        const next = await refreshAccessToken({ clientId: t.clientId, clientSecret: t.clientSecret || '', refreshToken: t.refreshToken, fetch: this.fetch, idBase: this.idBase, now: this.now });
        this.config = { ...this.config, twitch: { ...t, ...next } };
        await this.persist(this.config);
        this.status('twitch', 'token_refreshed');
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async ensureToken({ force = false } = {}) {
    const t = this.config.twitch;
    if (force || (t.expiresAt && t.expiresAt - this.now() < REFRESH_MARGIN_MS)) await this.refreshToken();
    let info = await validateToken({ accessToken: this.config.twitch.accessToken, fetch: this.fetch, idBase: this.idBase });
    if (!info) {
      await this.refreshToken();
      info = await validateToken({ accessToken: this.config.twitch.accessToken, fetch: this.fetch, idBase: this.idBase });
      if (!info) throw new TwitchAuthError('Twitch token is invalid; run "login" again', 401);
    }
    if (!info.scopes.includes(REQUIRED_CHAT_SCOPE)) throw new TwitchAuthError('Twitch token lacks ' + REQUIRED_CHAT_SCOPE + '; run "login" again');
    if (info.userId !== this.config.twitch.userId) throw new TwitchAuthError('Twitch token belongs to another account; run "login" again');
    return info;
  }

  async start() {
    // Retry transient failures (for example, OBS started before the network was up).
    for (let attempt = 0; ; attempt++) {
      try {
        await this.prepare();
        break;
      } catch (error) {
        if (isAuthError(error) || this.stopped) throw error;
        this.status('twitch', 'start_retry');
        await sleep(backoffDelay(attempt, { baseMs: this.baseMs, maxMs: this.maxMs, random: this.random }));
      }
    }
    this.connect();
  }

  async prepare() {
    await this.ensureToken();
    const t = this.config.twitch;
    if (!t.broadcasterUserId) {
      const broadcasterUserId = t.login === this.channel ? t.userId
        : await getUserId({ clientId: t.clientId, accessToken: t.accessToken, login: this.channel, fetch: this.fetch, helixBase: this.helixBase });
      this.config = { ...this.config, twitch: { ...this.config.twitch, broadcasterUserId } };
      await this.persist(this.config);
    }
  }

  connect() {
    if (this.stopped) return;
    this.backend = new BackendClient({
      url: backendSocketUrl(this.config.backend.origin, this.channel),
      credential: this.config.backend.credential,
      WebSocket: this.WebSocket,
      twitchConnected: () => this.twitchConnected(),
      random: this.random, baseMs: this.baseMs, maxMs: this.maxMs,
    });
    this.backend.on('ready', () => this.status('backend', 'connected'));
    this.backend.on('down', ({ code }) => this.status('backend', 'closed_' + code));
    this.backend.on('retry', () => this.status('backend', 'retry'));
    this.backend.on('ack', (ack) => this.emit('ack', ack));
    this.backend.on('fatal', ({ reason }) => this.fail(reason, reason === 'replaced_by_other_relay'
      ? 'Another relay replaced this one; only one relay can run per channel'
      : 'The Worker rejected the relay credential; pair again with a new code'));

    this.eventsub = new EventSubClient({ url: this.eventsubUrl, WebSocket: this.WebSocket, random: this.random, baseMs: this.baseMs, maxMs: this.maxMs });
    this.eventsub.on('session', (info) => this.onSession(info));
    this.eventsub.on('down', () => { this.setTwitch(false); this.status('twitch', 'eventsub_down'); });
    this.eventsub.on('retry', () => this.status('twitch', 'retry'));
    this.eventsub.on('notification', (frame) => this.onNotification(frame));
    this.eventsub.on('revocation', (info) => this.onRevocation(info));
    this.eventsub.start();

    this.validateTimer = setInterval(() => {
      this.ensureToken().catch((error) => {
        if (isAuthError(error)) this.fail('twitch_auth', error.message);
        else this.status('twitch', 'validate_failed');
      });
    }, VALIDATE_EVERY_MS);
    this.validateTimer.unref?.();
  }

  async subscribe(sessionId, retried = false) {
    const t = this.config.twitch;
    try {
      await subscribeChat({ clientId: t.clientId, accessToken: t.accessToken, sessionId, broadcasterUserId: t.broadcasterUserId, readerUserId: t.userId, fetch: this.fetch, helixBase: this.helixBase });
    } catch (error) {
      if (error.status === 401 && !retried) {
        await this.refreshToken();
        return this.subscribe(sessionId, true);
      }
      throw error;
    }
  }

  async onSession({ sessionId, migrated }) {
    if (migrated) { this.status('twitch', 'session_migrated'); this.setTwitch(true); return; }
    try {
      await this.subscribe(sessionId);
      if (this.eventsub.sessionId !== sessionId) return;
      this.status('twitch', 'subscribed');
      this.setTwitch(true);
    } catch (error) {
      if (isAuthError(error) && error.status !== 400) return this.fail('twitch_auth', error.message);
      this.status('twitch', 'subscribe_failed');
      this.eventsub.restart();
    }
  }

  onNotification(frame) {
    const message = parseEventSubMessage(frame, { now: this.now(), broadcasterUserId: this.config.twitch.broadcasterUserId });
    const event = routeChatMessage(message, this.lastPresence, this.now());
    if (!event) return;
    this.backend.send(event);
    this.emit('forwarded', event);
  }

  async onRevocation({ subscriptionType, status }) {
    this.status('twitch', 'revoked');
    this.setTwitch(false);
    if (subscriptionType !== 'channel.chat.message') return;
    // Try once to recover (a refreshed token and a new subscription); otherwise a new login is needed.
    try {
      await this.ensureToken({ force: true });
      await this.subscribe(this.eventsub.sessionId);
      this.setTwitch(true);
    } catch {
      this.fail('twitch_revoked', 'Twitch revoked the chat subscription (' + status + '); run "login" again');
    }
  }

  stop({ offline = true } = {}) {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    clearInterval(this.validateTimer);
    this.eventsub?.stop();
    this.stopping = Promise.resolve(this.backend?.stop({ offline })).then(() => this.status('relay', 'stopped'));
    return this.stopping;
  }
}
