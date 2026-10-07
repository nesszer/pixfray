import { connectChat } from './chat.js';
import { createArenaClient } from './arena-client.js';
import { drawHat } from './hats.js';
import { drawPet } from './pets.js';
import { recolorFilter, recoloredFrame, drawAccessory, createTrail, drawWinEffect, WIN_EFFECT_MS, TAUNTS, TITLES } from './cosmetics.js';

export function sanitizeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^!(jump|avatar|color)(?:\s+([^\s]+))?\s*$/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  if (type === 'jump') return match[2] ? null : { type };
  if (type === 'color') {
    const value = sanitizeColor(match[2]);
    return value ? { type, value } : null;
  }
  return /^[a-z0-9_-]{1,64}$/i.test(match[2] || '') ? { type, value: match[2].toLowerCase() } : null;
}

// ?cap= in the link: whole numbers 1..100; anything else (missing, 0, negative, text) means no limit of its own (100).
export function parseCap(value, fallback = 100) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : fallback;
}
// The limit in force: the lower of the link's ?cap= and the channel setting (maxOnStream, set by mods). Either can only tighten.
export function effectiveCap(urlCap, serverMax) {
  const server = Number.isInteger(serverMax) ? Math.max(1, Math.min(100, serverMax)) : 100;
  return Math.min(parseCap(urlCap), server);
}

// Text cuts by whole characters (grapheme clusters), never through an emoji, a flag or a ZWJ family; Array.from
// (code points) is the fallback where Intl.Segmenter is missing. Zalgo is limited to 2 combining marks per character.
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemesOf = (text) => (segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text));
export function stripExtraMarks(text) { return String(text ?? '').replace(/(\p{M}{2})\p{M}+/gu, '$1'); }
// At most `max` characters including the ellipsis, which is added only when something was cut.
export function truncateText(text, max, ellipsis = '') {
  const clean = stripExtraMarks(text), parts = graphemesOf(clean);
  if (parts.length <= max) return clean;
  return parts.slice(0, Math.max(0, max - Array.from(ellipsis).length)).join('') + ellipsis;
}
export const clipName = (text) => truncateText(text, 24, '…');   // nameplates

// Nameplate colors: Twitch chat colors can be near black (#0000ff, #8a2be2 ...). Below 4.5:1 against the dark stream
// backdrop the lightness goes up (hue and saturation stay) until the name reads, like Twitch's own dark mode.
const NAME_BACKDROP_LUM = 0.0053, NAME_MIN_CONTRAST = 4.5;
const channelLum = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lumOf = ([r, g, b]) => 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
const contrastOnDark = (rgb) => (lumOf(rgb) + 0.05) / (NAME_BACKDROP_LUM + 0.05);
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
export function readableColor(hex, minContrast = NAME_MIN_CONTRAST) {
  const color = sanitizeColor(hex);
  if (!color) return hex;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  if (contrastOnDark(rgb) >= minContrast) return color;
  const [r, g, b] = rgb.map((v) => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l0 = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  const h = d === 0 ? 0 : 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  let lo = l0, hi = 1;
  for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (contrastOnDark(hslToRgb(h, s, mid)) >= minContrast) hi = mid; else lo = mid; }
  let out = hslToRgb(h, s, hi);
  for (let l = hi; contrastOnDark(out) < minContrast && l < 1; l += 0.004) out = hslToRgb(h, s, l);
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// The overlay's own code version: vite.config.js (versionPublicModules) writes ?v=<hash of public/*.js> on the overlay's
// script URL in the built overlay.html, so the hash changes only when overlay code changes, not on every deploy.
export const overlayVersionFromUrl = (url) => { try { return (new URL(url).searchParams.get('v') || '').match(/^[0-9a-f]{6,64}$/i)?.[0] || ''; } catch { return ''; } };
export const overlayVersionFromHtml = (html) => String(html || '').match(/overlay\.js\?v=([0-9a-f]{6,64})/i)?.[1] || '';

// Arena events (docs/CONTRACTS.md section 3) older than this are history from the first snapshot, not news.
const EVENT_FRESH_MS = 10_000;
const OPEN = new Set(['pending', 'active']);
const CANCEL_TEXT = {
  inactivity: 'no action for a while', chat_disconnected: 'chat offline',
  duels_disabled: 'duels turned off', moderator_cancelled: 'cancelled by a moderator', moderator_reset: 'reset by a moderator',
  player_removed: 'player removed',
};

// The server's reason when the channel is off ('paused' | 'not_enabled'); '' (any other answer) lets the overlay run.
async function channelOff(channel) {
  try {
    const r = await fetch('/api/state/' + channel, { headers: { Accept: 'application/json' } });
    return r.status === 403 ? String((await r.json())?.off || '') : '';
  } catch { return ''; }
}

async function start() {
  const canvas = document.querySelector('#stage');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo') === '1';
  // Without ?channel= (OBS links always have it) the overlay shows the site's default channel, which /api/channels names.
  // The demo makes no API calls.
  const channel = (params.get('channel') || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25)
    || (demo ? '' : await fetch('/api/channels').then((r) => r.json()).then((j) => String(j.defaultChannel || '')).catch(() => '')) || 'demo';
  const arenaEnabled = params.get('arena') === '1';
  const arenaDemo = arenaEnabled && demo;
  const debug = params.get('debug') === '1';
  // A channel that is turned off or was never set up shows nothing. It checks again every 5 minutes, so turning
  // PixFray back on needs no OBS refresh. A channel that was never set up (often a typo in the OBS link) says so
  // for a minute, once per OBS session, so the streamer sees it in the OBS preview without it sitting on stream.
  const off = demo ? '' : await channelOff(channel);
  if (off) {
    const status = document.querySelector('#status');
    let told = true;
    try { told = sessionStorage.getItem('pixfray:off-told') === channel; sessionStorage.setItem('pixfray:off-told', channel); } catch { told = false; }
    if (off === 'not_enabled' && status && !told) {
      status.textContent = "PixFray isn't set up for \"" + channel + "\". Check the channel name in this OBS link, or set it up at " + location.host + "/start";
      setTimeout(() => { status.textContent = ''; }, 60_000);
    }
    setTimeout(() => location.reload(), 300_000); return;
  }
  // Most characters on screen: the lower of ?cap= and the channel setting (mod controls), which arrives with every snapshot.
  const urlCap = parseCap(params.get('cap'));
  let cap = urlCap;
  const size = Math.max(24, Math.min(96, Number(params.get('size')) || 60));
  // Duel announcement banner: off, top or bottom. The channel setting (mod controls) arrives with every snapshot and wins;
  // the ?announce= link parameter only covers the demo and the moment before the first snapshot.
  const ANNOUNCE = ['off', 'top', 'bottom'];
  let announce = ANNOUNCE.includes(params.get('announce')) ? params.get('announce') : 'off';
  // A new deploy changes the snapshot's build id. Most deploys leave the overlay's code alone, so the id only triggers a
  // cheap check: the overlay page is fetched again and its ?v= code hash compared with the one this script was loaded with.
  // Only changed overlay code reloads the page (between duels), so OBS never needs a manual refresh.
  const ownVersion = overlayVersionFromUrl(import.meta.url);   // empty on the dev server, which never reloads
  let firstBuild = '', lastBuild = '', staleBuild = false, buildChanged = false, versionCheckAt = 0, versionChecking = false;
  const sound = params.get('sound') === '1';   // quiet duel sounds, off unless asked for
  const bubbles = params.get('bubbles') !== '0';   // bubbles=0 hides every speech bubble: chat messages and win taunts
  const fxOn = params.get('fx') !== 'off';         // fx=off: no hit glow, sparks or knockout push-in
  const status = document.querySelector('#status');
  const storageKey = 'mini-chat:cosmetics:' + channel;
  let settings = Object.create(null);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) settings = Object.assign(Object.create(null), saved);
  } catch { /* OBS may disable local storage. */ }
  const players = new Map();
  const sprites = new Map();
  const profilesById = new Map();
  // Saved looks for chatters the arena doesn't list yet (a StreamElements channel only hears of a viewer when they
  // use a command): login -> { at, look }, misses included, refetched after 5 min. Batched, 20 logins per call.
  const savedLooks = new Map(), lookQueue = new Set();
  let lookTimer = 0;
  const meetPoints = new Map();
  // A quick duel is over on the server before the overlay sees it, so the overlay replays it from its events:
  // duel id -> an active duel whose hp follows the duel_action events until duel_completed.
  const replays = new Map();
  const KO_HOLD_MS = 2500;   // how long the loser stays down after a replayed knockout
  const DUEL_GROW = 1.5;     // fighters stand this much bigger while they duel
  const CHAT_BOTS = new Set(['streamelements', 'nightbot', 'moobot', 'fossabot', 'streamlabs', 'wizebot', 'sery_bot', 'soundalerts', 'kofistreambot', 'botrixoficial', 'pixfray']);   // same list as server/channel.js
  const FLOOR = 32;          // room under the feet for the nameplate
  const banners = [];        // the "Sudden death!" banner above a duel that goes to sudden death
  const results = [];        // every winner the overlay showed (debug and e2e)
  let shake = null;          // screen shake after a heavy blow or a knockout
  let push = null;           // knockout push-in: the view zooms toward the knockout for a moment
  const PUSH = .18, PUSH_IN = 250, PUSH_HOLD = 1600, PUSH_OUT = 700;
  const glows = [];          // light flashes where blows land
  const sparks = [];         // bright streaks thrown off by blows; they hold still during hit stop
  let width = 1, height = 1, connectionState = demo ? 'demo' : 'connecting';
  let arenaChat = null, arenaTransport = arenaDemo ? 'demo' : 'connecting', arenaConfig = { maxHp: 100 };
  let arenaRevision = null, arenaDuels = [], arenaClient = null, arenaTimer = null, arenaPaused = false;
  const announcements = [];   // top banner lines: one per duel (keyed by duel id) and one for the arena
  let lastCatalogFetch = 0;
  const missingAvatars = new Set();
  let lastFrame = performance.now(), lastCleanup = 0;
  const particles = [];
  const trail = createTrail();   // walking trails (cosmetics.js), in screen space
  function updateStatus(detail = '') {
    if (!status) return;
    const chatStatus = channel + ' · ' + connectionState + ' · ' + players.size + '/' + cap + ' characters';
    const chatOnline = arenaDemo || (arenaChat?.connected === true && ['connected', 'live'].includes(arenaTransport));
    const chatAge = Number(arenaChat?.lastSeen) > 0 ? Math.max(0, Math.floor((Date.now() - Number(arenaChat.lastSeen)) / 1000)) : null;
    const arenaStatus = arenaEnabled
      ? ' · arena ' + (chatOnline ? 'chat live' : arenaTransport) +
        (chatAge === null ? '' : ' · chat seen ' + (chatAge < 60 ? chatAge + 's' : Math.floor(chatAge / 60) + 'm') + ' ago') +
        (arenaRevision !== null ? ' r' + arenaRevision : '') +
        ' · ' + profilesById.size + ' profiles · ' + openDuels().length + ' duels'
      : '';
    if (debug) {
      status.textContent = chatStatus + arenaStatus + (detail ? ' · ' + detail : '');
      status.hidden = false;
    } else {   // nothing on stream; the admin page shows whether chat is connected
      status.textContent = '';
      status.hidden = true;
    }
  }
  function resize() {
    width = Math.max(1, innerWidth); height = Math.max(1, innerHeight);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    for (const p of players.values()) p.x = Math.max(size / 2, Math.min(width - size / 2, p.x));
  }
  addEventListener('resize', resize);
  resize();
  async function catalogItems(url) {
    const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Character catalog HTTP ' + response.status);
    const data = await response.json();
    if (Array.isArray(data)) return data;
    for (const key of ['characters', 'items', 'catalog', 'uploads']) {
      if (Array.isArray(data?.[key])) return data[key];
    }
    return [];
  }
  const validFrames = list => Array.isArray(list) ? list.filter(f =>
    f && [f.x, f.y, f.w, f.h].every(Number.isFinite) && f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0) : [];
  // Packs crop their frames differently: a frog or a pixel hero fills its frame, a Kenney adventurer leaves margin.
  // Measure the visible figure in the standing frame and shrink bulky ones so every fighter has about the same
  // on-stage size (sqrt of visible width x height, in frame heights). 0.78 keeps the original characters as they were.
  function bulkFit(image, frame) {
    try {
      const c = document.createElement('canvas');
      c.width = frame.w; c.height = frame.h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      const data = g.getImageData(0, 0, frame.w, frame.h).data;
      let left = frame.w, right = -1, top = frame.h, bottom = -1;
      for (let y = 0; y < frame.h; y++) for (let x = 0; x < frame.w; x++) {
        if (data[(y * frame.w + x) * 4 + 3] <= 40) continue;
        if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
      }
      if (right < left) return 1;
      const bulk = Math.sqrt((right - left + 1) * (bottom - top + 1)) / frame.h;
      return Math.min(1, 0.78 / bulk);
    } catch { return 1; }
  }
  function addSprite(id, item) {
    if (!item || typeof item.url !== 'string' || sprites.has(id)) return;
    const url = new URL(item.url, location.href);
    if (url.origin !== location.origin) return;
    const animations = {};
    for (const [name, list] of Object.entries(item.animations || {})) {
      const frames = validFrames(list);
      if (frames.length) animations[name] = frames;
    }
    const image = new Image();
    const sprite = { ...item, frames: validFrames(item.frames), animations, image, loaded: false, fps: Math.max(1, Math.min(30, Number(item.fps) || 8)) };
    image.onload = () => {
      if (!sprite.frames.length && image.naturalWidth && image.naturalHeight) {
        sprite.frames = [{ x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight }];
      }
      sprite.loaded = sprite.frames.length > 0;
      if (sprite.loaded) sprite.fit = bulkFit(image, sprite.frames[0]);
    };
    image.onerror = () => { sprite.loaded = false; };
    image.src = url.href;
    sprites.set(id, sprite);
  }
  // Custom characters can be uploaded while OBS is running; fetch the merged catalog again when one is missing.
  async function loadArenaCatalog() {
    lastCatalogFetch = Date.now();
    try {
      for (const item of await catalogItems('/api/catalog/' + encodeURIComponent(channel))) {
        if (typeof item?.id === 'string') addSprite(item.id.toLowerCase(), item);
      }
    } catch { /* The bundled sprite set stays available. */ }
  }
  try {
    for (const item of await catalogItems('./assets/characters.json')) {
      if (typeof item?.id === 'string') addSprite(item.id.toLowerCase(), item);
    }
  } catch { updateStatus('Using fallback characters'); }
  if (arenaEnabled && !arenaDemo) await loadArenaCatalog();
  const ids = [...sprites.keys()].filter(id => !sprites.get(id).custom);
  function persist() {
    // Bound storage so chat activity cannot grow an unlimited local profile file.
    const keys = Object.keys(settings);
    for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete settings[key];
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Storage is optional. */ }
  }
  function hop(p, amount) { p.vy = -amount; }
  const nameOf = id => {
    const profile = profilesById.get(String(id));
    return clipName(profile?.displayName || profile?.username || 'Player');
  };
  function openDuels() { return [...replays.values(), ...arenaDuels.filter(duel => OPEN.has(duel?.status) && !replays.has(duel.id))]; }
  const inReplay = p => [...replays.values()].some(d => String(d.a) === p.userId || String(d.b) === p.userId);
  // The state already holds the new Elo; during a replay the nameplate shows the Elo from before the duel.
  const replayRatings = id => { for (const d of replays.values()) if (!d.ratings) d.ratings = arenaDuels.find(x => x.id === d.id)?.ratings || null; for (const d of replays.values()) if (d.ratings?.[id]) return d.ratings[id]; return null; };
  function findPlayer(userId) {
    if (userId === null || userId === undefined || userId === '') return null;
    for (const p of players.values()) if (p.userId === String(userId)) return p;
    return null;
  }
  // Over the cap the stage keeps the most recent chatters and never touches a fighter: anyone in a duel (open or replayed)
  // stays until it is over. A profile sent off stage is remembered with its server lastSeen, so the next snapshot doesn't
  // bring it straight back (only fresher activity makes it eligible again, and only for a free place).
  const isFighter = p => inReplay(p) || duelFor(p) !== null;
  const droppedAt = new Map();   // userId -> the profile's server lastSeen when it left the stage
  const lastSeenOf = userId => Number(profilesById.get(String(userId))?.lastSeen) || 0;
  function dropPlayer(p) {
    players.delete(p.key);
    if (p.userId) droppedAt.set(p.userId, lastSeenOf(p.userId));
    if (droppedAt.size > 2000) droppedAt.delete(droppedAt.keys().next().value);
  }
  // A real chat join makes room by sending off the least recently active non-fighter; false if everyone on stage is fighting.
  function makeRoom() {
    if (players.size < cap) return true;
    let oldest = null;
    for (const q of players.values()) if (!isFighter(q) && (!oldest || q.lastSeen < oldest.lastSeen)) oldest = q;
    if (!oldest) return false;
    dropPlayer(oldest);
    return true;
  }
  function spawn(key, init) {
    if (!makeRoom()) return null;
    const saved = settings[key] && typeof settings[key] === 'object' ? settings[key] : {};
    const p = { key, userId: '', label: key, chatLabel: key, x: size / 2 + Math.random() * Math.max(0, width - size),
      speed: 14 + Math.random() * 20, direction: Math.random() < 0.5 ? -1 : 1, lane: Math.random() * 28, y: 0, vy: 0,
      avatar: sprites.has(saved.avatar) ? saved.avatar : ids[Math.floor(Math.random() * ids.length)],
      color: sanitizeColor(saved.color) || '#a78bfa', chatColor: null, lastJump: 0, phase: Math.random() * 1000,
      lastSeen: Date.now(), anim: null, ...init };
    players.set(key, p);
    return p;
  }
  // Registered profiles (saved on the website) decide name, color and character. Unregistered chatters keep their chat look.
  // A saved look is cached 5 min and "no saved fighter" 1 min, since viewers often save mid-stream. Lookups are batched
  // every 2 s so a few OBS sources on one connection stay under the edge rate limit (20 requests per 10 s per IP).
  function queueLook(login) {
    const hit = savedLooks.get(login);
    if (!arenaEnabled || arenaDemo || (hit && Date.now() - hit.at < (hit.look ? 300_000 : 60_000))) return;
    lookQueue.add(login);
    if (!lookTimer) lookTimer = setTimeout(fetchLooks, 2000);
  }
  async function fetchLooks() {
    const batch = [...lookQueue].slice(0, 20);
    for (const login of batch) { lookQueue.delete(login); savedLooks.set(login, { at: Date.now(), look: savedLooks.get(login)?.look || null }); }
    let retryMs = 2000;
    try {
      const response = await fetch('/api/looks/' + encodeURIComponent(channel) + '?u=' + batch.join(','), { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Looks HTTP ' + response.status);
      const data = await response.json();
      for (const login of batch) {
        const look = data && typeof data[login] === 'object' ? data[login] : null;
        savedLooks.set(login, { at: Date.now(), look: look ? { ...look, username: login, registered: true } : null });
      }
      for (const p of players.values()) if (batch.includes(p.key)) applyArenaProfile(p);
    } catch {
      // A failed lookup (a 429 from the rate limit blocks for 10 s) says nothing about the viewer: keep their current
      // look and ask again, rather than caching them as having no saved fighter.
      for (const login of batch) { savedLooks.get(login).at = 0; lookQueue.add(login); }
      retryMs = 10_000;
    }
    lookTimer = lookQueue.size ? setTimeout(fetchLooks, retryMs) : 0;
  }
  // Uploaded pets are PNGs served by /api/pets/<channel>/<id>; built-in pets are drawn in code (public/pets.js).
  const petImages = new Map();
  function petArt(id) {
    if (!/^p-[a-z0-9-]{1,40}$/.test(id)) return id;
    if (!petImages.has(id)) { const img = new Image(); img.src = '/api/pets/' + encodeURIComponent(channel) + '/' + id; petImages.set(id, { image: img }); }
    return petImages.get(id);
  }
  function applyArenaProfile(p) {
    const arena = arenaEnabled && p.userId ? profilesById.get(p.userId) : null;
    const profile = arena?.registered ? arena : (arenaEnabled && savedLooks.get(p.key)?.look) || arena || null;
    p.arenaProfile = profile || null;
    p.renderAvatar = p.avatar;
    p.defaultAbility = '';
    p.hat = '';
    p.pet = ''; p.petTier = '';
    p.recolor = p.petColor = p.accessory = p.trail = p.winEffect = p.taunt = p.title = '';
    if (!profile) return;
    if (profile.displayName || profile.username) p.label = clipName(profile.displayName || profile.username);
    if (!profile.registered) return;
    p.color = sanitizeColor(profile.color) || p.chatColor || p.color;
    const avatar = typeof profile.avatar === 'string' ? profile.avatar.toLowerCase() : '';
    if (sprites.has(avatar)) p.renderAvatar = avatar;
    // A newly seen id (fresh upload) refetches at once; ids that stay unknown retry at most every 30 s.
    else if (avatar && !arenaDemo && (!missingAvatars.has(avatar) || Date.now() - lastCatalogFetch > 30_000) && missingAvatars.add(avatar)) void loadArenaCatalog().then(() => { for (const q of players.values()) applyArenaProfile(q); });
    p.defaultAbility = String(profile.defaultAbility || '').slice(0, 20);
    p.hat = typeof profile.hat === 'string' ? profile.hat : '';
    p.pet = typeof profile.pet === 'string' ? profile.pet : '';
    p.petTier = typeof profile.petTier === 'string' ? profile.petTier : '';
    // Cosmetics (cosmetics.js): ids only; unknown ones draw nothing.
    for (const field of ['recolor', 'petColor', 'accessory', 'trail', 'winEffect', 'taunt', 'title']) p[field] = typeof profile[field] === 'string' ? profile[field].slice(0, 32) : '';
  }
  function acceptArenaSnapshot(snapshot, metadata = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    arenaChat = snapshot.chat && typeof snapshot.chat === 'object' ? snapshot.chat : null;
    if (snapshot.config && typeof snapshot.config === 'object') arenaConfig = snapshot.config;
    if (ANNOUNCE.includes(arenaConfig.announce)) announce = arenaConfig.announce;
    const wanted = effectiveCap(urlCap, arenaConfig.maxOnStream);   // the lower of the link's ?cap= and the channel setting
    if (wanted !== cap) {
      cap = wanted;
      // A lower limit sends the longest-quiet chatters off first; fighters (open duel or replay) stay.
      const quiet = [...players.values()].filter(p => !isFighter(p)).sort((a, b) => a.lastSeen - b.lastSeen);
      while (players.size > cap && quiet.length) dropPlayer(quiet.shift());
    }
    if (typeof snapshot.build === 'string' && snapshot.build) {
      if (!firstBuild) firstBuild = lastBuild = snapshot.build;
      else if (snapshot.build !== lastBuild) { lastBuild = snapshot.build; if (ownVersion) buildChanged = true; }
    }
    arenaPaused = snapshot.paused === true;
    arenaRevision = Number.isFinite(Number(metadata.revision)) ? Number(metadata.revision)
      : Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : arenaRevision;
    profilesById.clear();
    for (const profile of Array.isArray(snapshot.players) ? snapshot.players : []) {
      if (profile?.userId !== undefined && profile?.userId !== null) profilesById.set(String(profile.userId), profile);
    }
    arenaDuels = Array.isArray(snapshot.duels) ? snapshot.duels : [];
    if (arenaChat?.connected === true) arenaTransport = 'live';
    // Every overlay shows the same arena: the server's player list (fed by Twitch EventSub) spawns characters even
    // when this overlay's own chat connection is down, and players the server dropped leave the stage.
    for (const [key, p] of players) if (p.fromArena && !profilesById.has(p.userId)) players.delete(key);
    // The stage fills with the most recently active profiles while there is room. A snapshot never sends anyone off
    // (that happens when a new chatter joins, see spawn), so with more active players than the cap nothing churns.
    // The server's lastSeen is turned into "ms ago" relative to its newest profile, so it orders against local chat times.
    let newest = 0;
    for (const profile of profilesById.values()) newest = Math.max(newest, Number(profile.lastSeen) || 0);
    const activity = profile => Date.now() - Math.max(0, newest - (Number(profile.lastSeen) || 0));
    const candidates = [];
    for (const [userId, profile] of profilesById) {
      const here = findPlayer(userId);
      if (here) { here.lastSeen = Math.max(here.lastSeen, activity(profile)); continue; }
      const key = String(profile.username || 'id:' + userId).toLowerCase().slice(0, 64);
      const existing = players.get(key);
      if (existing) { existing.userId = userId; continue; }
      const seen = Number(profile.lastSeen) || 0;
      if (droppedAt.has(userId) && seen <= droppedAt.get(userId)) continue;   // sent off earlier and no more active since
      candidates.push({ userId, profile, key, seen });
    }
    candidates.sort((a, b) => b.seen - a.seen);
    for (const { userId, profile, key } of candidates) {
      if (players.size >= cap) break;
      droppedAt.delete(userId);
      const label = clipName(profile.displayName || key);
      spawn(key, { userId, fromArena: true, label, chatLabel: label, lastSeen: activity(profile) });
    }
    const now = Date.now();
    for (const p of players.values()) {
      applyArenaProfile(p);
      const respawnAt = Number(p.arenaProfile?.respawnAt) || 0;
      if (inReplay(p) || p.koHoldUntil > now) continue;
      if (respawnAt > now && !(p.koUntil > now)) p.koStart = now;
      p.koUntil = respawnAt > now ? respawnAt : 0;
    }
    for (const id of meetPoints.keys()) if (!replays.has(id) && !arenaDuels.some(duel => duel.id === id && duel.status === 'active')) meetPoints.delete(id);
    updateStatus();
  }
  // The overlay page as the server serves it now: its script tag names the current code hash. At most one check
  // every 30 s while the build id keeps changing (a rollout can serve two versions side by side); a failed fetch retries.
  async function checkOverlayVersion() {
    versionChecking = true; versionCheckAt = Date.now();
    try {
      const response = await fetch(location.pathname + location.search, { cache: 'no-store', headers: { accept: 'text/html' } });
      if (!response.ok) throw new Error('Overlay page HTTP ' + response.status);
      const latest = overlayVersionFromHtml(await response.text());
      buildChanged = false;
      if (latest && latest !== ownVersion) staleBuild = true;
    } catch { /* keep buildChanged: the next tick asks again */ }
    versionChecking = false;
  }
  setInterval(() => {
    if (buildChanged && !versionChecking && Date.now() - versionCheckAt >= 30_000) void checkOverlayVersion();
    if (!staleBuild || replays.size) return;
    // At most one reload a minute, in case a rollout serves two versions side by side.
    try {
      const last = Number(sessionStorage.getItem('mini-chat-reload')) || 0;
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem('mini-chat-reload', String(Date.now()));
    } catch { return; }   // without storage there's no loop guard, so keep running the old code
    location.reload();
  }, 5000);
  // Two duels at once each keep their own line; a newer message for the same duel replaces its line.
  function announceArena(text, color = '#fde68a', key = 'arena') {
    if (!text) return;
    const i = announcements.findIndex(a => a.key === key);
    if (i >= 0) announcements.splice(i, 1);
    announcements.push({ key, text: truncateText(text, 100), color, until: Date.now() + 5500 });
    if (announcements.length > 3) announcements.shift();
  }
  const liveAnnouncements = () => announcements.filter(a => Date.now() < a.until);
  function burst(p, color, count, rise) {
    if (!p) return;
    for (let i = 0; i < count; i++) {
      particles.push({ x: p.x + (Math.random() - .5) * size * .5, y: -size * (p.grow || 1) * (.3 + Math.random() * .5), owner: p, color,
        vx: (Math.random() - .5) * 120, vy: rise ? -40 - Math.random() * 60 : -120 - Math.random() * 120, born: Date.now(), life: 700 });
    }
    if (particles.length > 300) particles.splice(0, particles.length - 300);
  }
  // A landed blow: a flash of light on the target and a spray of sparks away from the attacker.
  // power: 1 a normal blow, 2 heavy or crit, 3 the finishing blow.
  function landBlow(target, dealer, color, power) {
    if (!fxOn || !target) return;
    const now = Date.now(), s = size * (target.grow || 1);
    const dir = dealer ? Math.sign(target.x - dealer.x) || 1 : 0;
    glows.push({ owner: target, color, y: -s * .55, r: s * (.6 + .25 * power), born: now, life: 200 + 90 * power });
    for (let i = 0, n = 6 + power * 7; i < n; i++) {
      const a = (Math.random() - .5) * 2.2 - .4, speed = (220 + Math.random() * 320) * (.7 + power * .2);
      const side = dir || (Math.random() < .5 ? -1 : 1);
      sparks.push({ owner: target, color, x: target.x, y: -s * (.4 + Math.random() * .3), vx: Math.cos(a) * speed * side, vy: Math.sin(a) * speed,
        born: now, life: 320 + Math.random() * 260 });
    }
    if (sparks.length > 240) sparks.splice(0, sparks.length - 240);
    if (power >= 2 && !(shake && now < shake.until)) shake = { start: now, until: now + 220, mag: 4 };
  }
  // The knockout: a hard shake, and the view pushes in on the fallen fighter, holds, and eases back.
  function knockout(p, at) {
    shake = { start: at, until: at + 450, mag: 9 };
    if (fxOn && p) push = { x: p.x, y: height - FLOOR - p.lane, start: at };
  }
  function pushZoom(clock) {
    if (!push) return 1;
    const t = clock - push.start, ease = u => u * u * (3 - 2 * u);
    if (t < 0) return 1;
    if (t < PUSH_IN) return 1 + PUSH * (1 - (1 - t / PUSH_IN) ** 3);
    if (t < PUSH_IN + PUSH_HOLD) return 1 + PUSH;
    if (t < PUSH_IN + PUSH_HOLD + PUSH_OUT) return 1 + PUSH * (1 - ease((t - PUSH_IN - PUSH_HOLD) / PUSH_OUT));
    push = null;
    return 1;
  }
  function floatText(p, text, color, life = 1200) { if (p) p.floatText = { text, color, life, until: Date.now() + life }; }
  const signed = n => (n > 0 ? '+' : n < 0 ? '\u2212' : '') + Math.abs(n);
  // &sound=1: short synthesized blips, no audio files. Browsers and OBS allow this without a click.
  let audio = null;
  function playSound(kind) {
    if (!sound) return;
    try {
      audio ||= new AudioContext();
      const t = audio.currentTime, gain = audio.createGain();
      gain.connect(audio.destination);
      if (kind === 'miss') {
        const len = Math.floor(audio.sampleRate * .22), buffer = audio.createBuffer(1, len, audio.sampleRate), data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / len);
        const src = audio.createBufferSource(), band = audio.createBiquadFilter();
        band.type = 'bandpass'; band.frequency.setValueAtTime(700, t); band.frequency.exponentialRampToValueAtTime(2600, t + .22);
        src.buffer = buffer; src.connect(band); band.connect(gain); gain.gain.value = .12; src.start(t);
        return;
      }
      const [type, from, to, dur, vol] = { hit: ['square', 190, 55, .13, .07], parry: ['triangle', 1100, 1500, .09, .08], ko: ['sawtooth', 240, 50, .6, .06] }[kind] || ['square', 190, 55, .13, .07];
      const osc = audio.createOscillator();
      osc.type = type; osc.frequency.setValueAtTime(from, t); osc.frequency.exponentialRampToValueAtTime(to, t + dur);
      gain.gain.setValueAtTime(vol, t); gain.gain.exponentialRampToValueAtTime(.001, t + dur);
      osc.connect(gain); osc.start(t); osc.stop(t + dur + .02);
    } catch { /* No audio is fine. */ }
  }
  // A quick-duel roll (docs/CONTRACTS.md section 3, events with a die): the die pops above the fighter who rolled,
  // then the outcome plays. A counter is the defender answering a bad roll, so the die belongs to its target.
  const ROLL_REVEAL_MS = 450, IMPACT_MS = 200;
  function playRoll(event, replay) {
    const now = Date.now();
    const dealer = findPlayer(event.userId), target = findPlayer(event.targetId);
    const roller = event.counter ? target : dealer, other = event.counter ? dealer : target;
    if (roller) roller.die = { value: Math.max(1, Math.min(6, Math.round(event.die))), start: now, until: now + 1000 };
    if (replay) {
      replay.rolls = (replay.rolls || 0) + 1;
      if (replay.rolls === 13) banners.push({ x: meetPoints.get(replay.id)?.x ?? roller?.x ?? width / 2, text: 'Sudden death!', title: 'Sudden death!', color: '#fde047', start: now, until: now + 1200 });
    }
    const showHp = () => { if (replay && event.hp && typeof event.hp === 'object') replay.hp = { ...event.hp }; };   // the bar moves when the blow lands
    setTimeout(() => {
      const t = Date.now(), look = event.ability === 'heavy' ? 'smash' : event.ability === 'heal' ? 'glow' : 'slash';
      if (event.miss) {
        if (roller) { roller.anim = { kind: 'attack', start: t, until: t + 450 }; roller.whoosh = { start: t + 80, until: t + 480 }; }
        if (other) other.anim = { kind: 'dodge', start: t + 60, until: t + 600 };
        floatText(other, 'MISS', '#e2e8f0');
        showHp(); playSound('miss');
        return;
      }
      let swing = t;
      if (event.counter && dealer) { dealer.parry = { start: t, until: t + 380 }; floatText(dealer, 'COUNTER', '#fbbf24'); swing = t + 300; playSound('parry'); }
      const heavy = look === 'smash' || event.crit === true, impact = swing + IMPACT_MS, stop = event.finisher ? 260 : 80;
      if (dealer) dealer.anim = { kind: 'attack', heavy, start: swing, until: swing + 450 };
      if (target) target.anim = { kind: 'hit', heavy, start: impact, until: impact + 400 };
      if (look === 'glow' && dealer) dealer.fx = { look: 'aura', start: swing, until: swing + 600 };
      for (const f of [dealer, target]) if (f) { f.stopStart = impact; f.stopUntil = impact + stop; }
      setTimeout(() => {
        const at = Date.now(), amount = Number(event.amount) || 0;
        showHp();
        if (target) target.fx = { look, start: at, until: at + 450 };
        const color = event.crit ? '#fde047' : look === 'smash' ? '#f97316' : look === 'glow' ? '#4ade80' : '#fb7185';
        burst(target, color, event.crit || event.finisher ? 22 : 10, false);
        landBlow(target, dealer, color, event.finisher ? 3 : heavy ? 2 : 1);
        floatText(target, (event.crit ? 'CRIT! ' : '') + '-' + amount, event.crit ? '#fde047' : '#fb7185');
        if (event.finisher && target) {
          knockout(target, at);
          if (!(target.koUntil > at)) target.koStart = at;
          target.koUntil = target.koHoldUntil = Math.max(target.koUntil || 0, at + KO_HOLD_MS + 1500);
        }
        playSound(event.finisher ? 'ko' : 'hit');
      }, Math.max(0, impact - Date.now()));
    }, ROLL_REVEAL_MS);
  }
  // Events of one duel that arrive together (a quick duel sends start, hit and KO at once) play one after another.
  // The fighters first walk to meet (duel_started waits for that), then each swing gets its own beat.
  // A roll takes about 1.8 s; after the finishing blow the result follows once the knockout has landed.
  const DUEL_EVENT_GAP_MS = { duel_started: 700, duel_action: 1800 };
  const FINISHER_GAP_MS = 1300;
  const DUEL_WALK_MS = 2000;   // longest walk to the meet point; far-apart fighters walk faster
  const duelQueues = new Map();
  // The fighter's knockout is queued but not played yet (a finishing blow or the result of a duel still in the queue).
  const pendingKnockout = p => [...duelQueues.values()].some(q => q.items.some(({ event: e }) =>
    (e.type === 'duel_action' && e.finisher && String(e.targetId) === p.userId) || (e.type === 'duel_completed' && String(e.loserId) === p.userId)));
  function queueArenaEvent(event) {
    const id = event?.duelId;
    if (!id) return handleArenaEvent(event);
    let q = duelQueues.get(id);
    if (!q) duelQueues.set(id, q = { items: [], busy: false });
    q.items.push({ event, received: Date.now() });
    if (!q.busy) pumpDuel(id, q);
  }
  function pumpDuel(id, q) {
    const item = q.items.shift();
    if (!item) { q.busy = false; duelQueues.delete(id); return; }
    q.busy = true;
    const { event, received } = item, waited = Date.now() - received;
    handleArenaEvent(waited && Number.isFinite(event.at) ? { ...event, at: event.at + waited } : event);
    const gap = event.type === 'duel_started' ? Math.max(DUEL_EVENT_GAP_MS.duel_started, (meetPoints.get(id)?.walkMs || 0) + 200) : event.type === 'duel_action' && event.finisher && Number.isFinite(event.die) ? FINISHER_GAP_MS : (DUEL_EVENT_GAP_MS[event.type] || 0);
    if (gap) setTimeout(() => pumpDuel(id, q), gap); else pumpDuel(id, q);
  }
  function handleArenaEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (Number.isFinite(event.at) && Date.now() - event.at > EVENT_FRESH_MS) return;
    const now = Date.now();
    switch (event.type) {
      case 'challenge_created':
        announceArena(nameOf(event.a) + ' challenges ' + nameOf(event.b) + ' to a duel', undefined, event.duelId);
        break;
      case 'challenge_declined':
        announceArena(nameOf(event.declinedBy) + ' declined the duel', '#e2e8f0', event.duelId);
        break;
      case 'challenge_expired':
        announceArena('Challenge to ' + nameOf(event.b) + ' expired', '#e2e8f0', event.duelId);
        break;
      case 'duel_started':
        if (event.duelId && event.a && event.b) {
          replays.set(event.duelId, { id: event.duelId, a: String(event.a), b: String(event.b), status: 'active', hp: { ...(event.hp || {}) }, rules: { maxHp: Number(arenaConfig?.maxHp) || 100 } });
          const fa = findPlayer(String(event.a)), fb = findPlayer(String(event.b));
          if (fa && fb && !meetPoints.has(event.duelId)) {
            const meet = { ...placeMeet((fa.x + fb.x) / 2), aLeft: fa.x <= fb.x };
            const far = Math.max(Math.abs(fa.x - meet.x), Math.abs(fb.x - meet.x));
            meet.speed = Math.max(110, far / (DUEL_WALK_MS / 1000));
            meet.walkMs = Math.min(DUEL_WALK_MS, far / meet.speed * 1000);
            meetPoints.set(event.duelId, meet);
          }
          for (const id of [event.a, event.b]) { const f = findPlayer(String(id)); if (f && !(f.koHoldUntil > now)) f.koUntil = 0; }   // state may already show the KO
          setTimeout(() => replays.delete(event.duelId), 60000);   // safety net if duel_completed never arrives
        }
        announceArena('Round ' + event.round + ': ' + nameOf(event.a) + ' vs ' + nameOf(event.b), undefined, event.duelId);
        break;
      case 'duel_action': {
        const replay = replays.get(event.duelId);
        if (Number.isFinite(event.die)) { playRoll(event, replay); break; }
        if (replay && event.hp && typeof event.hp === 'object') replay.hp = { ...event.hp };
        const actor = findPlayer(event.userId), target = findPlayer(event.targetId);
        if (event.ability === 'heal') {
          if (actor) actor.anim = { kind: 'heal', start: now, until: now + 900 };
          burst(actor, '#4ade80', 10, true);
          floatText(actor, '+' + (Number(event.amount) || 0), '#4ade80');
        } else {
          if (actor) actor.anim = { kind: 'attack', heavy: event.ability === 'heavy', start: now, until: now + 450 };
          if (target) target.anim = { kind: 'hit', heavy: event.ability === 'heavy', start: now + 120, until: now + 520 };
          if (event.miss) { if (target) { target.anim = null; hop(target, 180); } floatText(target, 'MISS', '#e2e8f0'); break; }
          burst(target, event.ability === 'heavy' ? '#f97316' : '#fb7185', event.ability === 'heavy' ? 16 : 8, false);
          landBlow(target, actor, event.ability === 'heavy' ? '#f97316' : '#fb7185', event.ability === 'heavy' ? 2 : 1);
          floatText(target, event.counter ? 'COUNTER' : '-' + (Number(event.amount) || 0), '#fb7185');
        }
        break;
      }
      case 'duel_completed': {
        const winner = findPlayer(event.winnerId), loser = findPlayer(event.loserId);
        replays.delete(event.duelId); meetPoints.delete(event.duelId);
        if (loser) {
          const down = loser.koUntil > now;   // the finishing blow already knocked them down
          if (!down) { loser.koStart = now; burst(loser, '#fbbf24', 18, false); knockout(loser, now); }
          loser.koUntil = loser.koHoldUntil = Math.max(Number(event.respawnAt) || 0, now + KO_HOLD_MS);
        }
        // Both stay big and in place for the afterglow, then walk off.
        for (const f of [winner, loser]) if (f) { f.bigUntil = now + KO_HOLD_MS; f.holdUntil = now + KO_HOLD_MS; }
        if (winner) { winner.anim = { kind: 'cheer', start: now, until: now + 1400 }; hop(winner, 220); }
        // The winner's win effect and taunt (preset lines only; no taunt bubble with bubbles=0).
        if (winner?.winEffect) winner.winFx = { id: winner.winEffect, start: now, seed: (now % 997) + 1 };
        if (bubbles && winner && TAUNTS[winner.taunt]) { winner.text = TAUNTS[winner.taunt]; winner.messageId = ''; winner.bubbleUntil = now + 4500; }
        // An unrated duel (event.unrated: "new_account" or "pair_cap") moves no Elo, so it shows "Just for fun" over the
        // winner instead of "+0 Elo", and the result line leaves the Elo out.
        const unrated = Boolean(event.unrated);
        const rw = unrated ? null : event.ratings?.[event.winnerId], rl = unrated ? null : event.ratings?.[event.loserId];
        if (unrated) floatText(winner, 'Just for fun', '#e2e8f0', 2200);
        if (Number.isFinite(rw?.delta)) floatText(winner, signed(rw.delta) + ' Elo', '#4ade80', 2200);
        if (Number.isFinite(rl?.delta)) floatText(loser, signed(rl.delta) + ' Elo', '#fb7185', 2200);
        const text = (event.decision === 'hp' ? 'Time! ' : '') + nameOf(event.winnerId) + ' wins' + (event.decision === 'hp' ? ' on HP' : '') +
          (event.flawless ? ', FLAWLESS!' : '!') + (Number.isFinite(rw?.delta) ? ' ' + signed(rw.delta) + ' Elo' : '');
        // No winner banner: the knockout, the cheer and the Elo floats show it, and the PixFray bot names the winner in
        // chat once the stream has shown it. The debug hook still lists each winner.
        results.push({ duelId: event.duelId, text, at: now });
        if (results.length > 20) results.shift();
        break;
      }
      case 'duel_cancelled':
        announceArena('Duel cancelled · ' + (CANCEL_TEXT[event.reason] || 'not scored'), '#e2e8f0', event.duelId);
        break;
      case 'player_respawned': {
        const p = findPlayer(event.userId);
        // The server times the respawn from the settled duel, but the overlay's replay of it runs longer. While the
        // fighter is in a replay (or the knockout is still queued) the event waits; the KO hold then stands them up.
        if (p && (inReplay(p) || pendingKnockout(p)) && (event.tries || 0) < 400) setTimeout(() => handleArenaEvent({ ...event, at: undefined, tries: (event.tries || 0) + 1 }), 250);
        else if (p && p.koHoldUntil > now) setTimeout(() => handleArenaEvent({ ...event, at: undefined }), p.koHoldUntil - now + 20);   // stand up after the replayed KO
        else if (p) { p.koUntil = 0; p.anim = { kind: 'respawn', start: now, until: now + 700 }; burst(p, '#bfdbfe', 10, true); }
        break;
      }
      case 'chat_disconnected':
        announceArena('Duels paused · chat offline', '#e2e8f0');
        break;
      case 'chat_connected':
        if (arenaChat?.connected !== false) announceArena('Duels are live', '#a7f3d0');
        break;
      default:
    }
    updateStatus();
  }
  function duelFor(p) {
    if (!arenaEnabled || !p.userId) return null;
    return openDuels().find(duel => String(duel.a) === p.userId || String(duel.b) === p.userId) || null;
  }
  function healthOf(p, duel) {
    if (!duel || duel.status !== 'active') return null;
    const current = Number(duel.hp?.[p.userId]);
    if (!Number.isFinite(current)) return null;
    const max = Number(duel.rules?.maxHp ?? arenaConfig?.maxHp ?? 100);
    return { current: Math.max(0, current), max: Math.max(1, Number.isFinite(max) ? max : 100) };
  }
  function onMessage(message) {
    const username = String(message.username || message.userId || '').toLowerCase().slice(0, 64);
    if (!username || CHAT_BOTS.has(username)) return;
    const now = Date.now();
    let p = players.get(username) || (message.userId ? findPlayer(message.userId) : null);
    if (!p) {   // a real join: over the cap this sends the least recently active non-fighter off; no room if all are fighting
      const label = clipName(message.displayName || username);
      p = spawn(username, { label, chatLabel: label });
      if (p) droppedAt.delete(String(message.userId ?? ''));
    }
    if (!p) return;
    if (message.userId !== undefined && message.userId !== null) p.userId = String(message.userId);
    if (message.displayName) p.chatLabel = clipName(message.displayName);
    if (sanitizeColor(message.color)) p.chatColor = sanitizeColor(message.color);
    if (!p.arenaProfile) {
      p.label = p.chatLabel || p.label;
      p.color = sanitizeColor(settings[username]?.color) || p.chatColor || p.color;
    }
    applyArenaProfile(p);
    if (!p.arenaProfile?.registered) queueLook(username);
    const ranked = Boolean(p.arenaProfile?.registered);
    p.lastSeen = now; p.messageId = message.id || ''; p.text = bubbles ? truncateText(message.text || '', 72) : ''; p.bubbleUntil = now + 4000;
    const command = parseCommand(message.text || '');
    if (command?.type === 'jump') {
      if (now - p.lastJump >= 3000) { hop(p, 300); p.lastJump = now; }
      p.text = '';
    } else if (command?.type === 'avatar') {
      if (!ranked && sprites.has(command.value)) { p.avatar = command.value; settings[username] = { avatar: p.avatar, color: p.color }; persist(); applyArenaProfile(p); }
      p.text = '';
    } else if (command?.type === 'color') {
      if (!ranked) { p.color = command.value; settings[username] = { avatar: p.avatar, color: p.color }; persist(); }
      p.text = '';
    } else if (now - (p.lastReaction || 0) > 1500 && !duelFor(p)) { hop(p, 140); p.lastReaction = now; }
    updateStatus();
  }
  function onModeration(event) {
    if (event.type === 'clear') { for (const [key, p] of players) if (!p.fromArena) players.delete(key); }
    else if (event.type === 'delete') {
      for (const p of players.values()) if (p.messageId === event.messageId) { p.text = ''; p.bubbleUntil = 0; }
    } else {
      for (const [key, p] of players) if ((event.userId && p.userId === String(event.userId)) || (event.username && key === String(event.username).toLowerCase())) players.delete(key);
    }
    updateStatus();
  }
  function drawFallback(p, x, y, time) {
    const step = Math.sin(time * 0.012 + p.phase) * 3;
    ctx.fillStyle = p.color;
    ctx.fillRect(x - 11, y - 31, 22, 22);
    ctx.fillRect(x - 8, y - 12, 6, 12 + step);
    ctx.fillRect(x + 2, y - 12, 6, 12 - step);
    ctx.beginPath(); ctx.arc(x, y - 39, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x + p.direction * 3 - 5, y - 42, 3, 4); ctx.fillRect(x + p.direction * 3 + 2, y - 42, 3, 4);
  }
  function drawHealthBar(p, x, y, health, s) {
    const barWidth = barWidthOf(s);
    const left = x - barWidth / 2;
    const top = y - s - 20;
    const ratio = Math.max(0, Math.min(1, health.current / health.max));
    ctx.fillStyle = 'rgba(9,12,18,.86)';
    ctx.fillRect(left - 2, top - 2, barWidth + 4, 12);
    ctx.fillStyle = ratio > .55 ? '#4ade80' : ratio > .25 ? '#fbbf24' : '#fb7185';
    ctx.fillRect(left, top, barWidth * ratio, 8);
    ctx.strokeStyle = 'rgba(255,255,255,.72)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, barWidth, 8);
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.9)';
    ctx.fillStyle = '#e2e8f0';
    const text = Math.round(health.current) + '/' + Math.round(health.max);
    ctx.strokeText(text, x, top - 5);
    ctx.fillText(text, x, top - 5);
  }
  // Die face above the fighter who rolled: it tumbles for a moment, then settles on the rolled value.
  const PIPS = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
  function drawDie(p, x, y, s, now) {
    const d = p.die;
    if (!d || now >= d.until) return;
    const age = now - d.start, rolling = age < 350;
    const value = rolling ? 1 + Math.floor(age / 60 + p.phase) % 6 : d.value;
    const side = 34 * (rolling ? .85 + .15 * Math.sin(age / 35) : Math.min(1.15, 1 + Math.max(0, (420 - age) / 400) * .15));
    ctx.save();
    ctx.globalAlpha = Math.min(1, (d.until - now) / 250);
    ctx.translate(x, y - s - 66);
    if (rolling) ctx.rotate(Math.sin(age / 40) * .5);
    ctx.fillStyle = d.value === 6 && !rolling ? '#fde047' : '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-side / 2, -side / 2, side, side, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111827';
    for (const [px, py] of PIPS[value]) { ctx.beginPath(); ctx.arc(px * side * .27, py * side * .27, side * .09, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  // Cosmetic look of a blow (the fighter's default ability), a parry flash and a miss whoosh.
  function drawStrikeFx(p, x, y, s, now) {
    const fade = fx => Math.max(0, Math.min(1, (now - fx.start) / (fx.until - fx.start)));
    ctx.save();
    ctx.lineCap = 'round';
    if (p.fx && now >= p.fx.start && now < p.fx.until) {
      const t = fade(p.fx);
      ctx.globalAlpha = 1 - t;
      if (p.fx.look === 'slash') {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(x - s * .35, y - s * .35, s * .55, -Math.PI * .55, -Math.PI * .55 + Math.PI * .7 * Math.min(1, t * 2.5)); ctx.stroke();
      } else if (p.fx.look === 'smash') {
        ctx.strokeStyle = '#f97316'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.ellipse(x, y - 2, s * (.3 + t * .7), s * .1 * (1 + t), 0, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(x, y - s * .5, s * (.35 + t * .35), 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (p.parry && now >= p.parry.start && now < p.parry.until) {
      const t = fade(p.parry), cx = x + p.direction * s * .35, cy = y - s * .6;
      ctx.globalAlpha = 1 - t; ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 4;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, r0 = s * .08, r1 = s * (.2 + t * .25);
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
      }
    }
    if (p.whoosh && now >= p.whoosh.start && now < p.whoosh.until) {
      const t = fade(p.whoosh);
      ctx.globalAlpha = .8 * (1 - t); ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3;
      for (let i = 0; i < 3; i++) {
        const cx = x + p.direction * s * (.45 + t * .5), cy = y - s * (.35 + i * .18);
        ctx.beginPath(); ctx.moveTo(cx - p.direction * s * (.5 - i * .08), cy); ctx.lineTo(cx, cy); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function drawBanners(now) {
    for (let i = banners.length - 1; i >= 0; i--) if (now >= banners[i].until) banners.splice(i, 1);
    for (const b of banners) {
      // Outlined game text like the hit numbers, no box: it pops in a little large, settles, and fades out rising.
      const age = now - b.start, t = Math.min(1, age / 220), out = Math.max(0, 1 - (b.until - now) / 300);
      const pop = 1 + .35 * (1 - t) * (1 - t) - .06 * Math.sin(Math.PI * t);
      ctx.save();
      ctx.globalAlpha = Math.min(1, age / 80) * (1 - out);
      ctx.font = '800 34px system-ui, sans-serif';
      const w = Math.min(width - 16, ctx.measureText(b.title).width + 16), x = Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, b.x));
      const top = height - FLOOR - 28 - size * DUEL_GROW - 150 - out * 8;
      ctx.translate(x, top + 24); ctx.scale(pop, pop);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(10,12,20,.92)';
      ctx.strokeText(b.title, 0, 0, w); ctx.fillStyle = b.color; ctx.fillText(b.title, 0, 0, w);
      if (b.sub) {
        ctx.font = '800 17px system-ui, sans-serif'; ctx.lineWidth = 5;
        ctx.strokeText(b.sub, 0, 28, w); ctx.fillStyle = '#fbbf24'; ctx.fillText(b.sub, 0, 28, w);
      }
      ctx.restore();
    }
  }
  function drawEffects(p, x, y, now, s, animNow) {
    const anim = p.anim && animNow < p.anim.until ? p.anim : null;
    if (anim && (anim.kind === 'heal' || anim.kind === 'hit' || anim.kind === 'respawn')) {
      const t = Math.max(0, Math.min(1, (animNow - anim.start) / (anim.until - anim.start)));
      const color = anim.kind === 'heal' ? '#4ade80' : anim.kind === 'hit' ? '#fb7185' : '#bfdbfe';
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y - s * .55, s * (.4 + t * .25), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawStrikeFx(p, x, y, s, now);
    if (p.floatText && now < p.floatText.until) {
      const t = 1 - (p.floatText.until - now) / p.floatText.life;
      ctx.save();
      ctx.globalAlpha = Math.min(1, 2 - t * 2);
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.fillStyle = p.floatText.color;
      ctx.strokeText(p.floatText.text, x, y - s - 46 - t * 30);
      ctx.fillText(p.floatText.text, x, y - s - 46 - t * 30);
      ctx.restore();
    }
    drawDie(p, x, y, s, now);
  }
  function drawParticles(now, dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const s = particles[i];
      const age = now - s.born;
      if (age > s.life || !players.has(s.owner.key)) { particles.splice(i, 1); continue; }
      s.vy += 380 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      ctx.globalAlpha = 1 - age / s.life;
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - 3, height - FLOOR - s.owner.lane + s.y - 3, 6, 6);
    }
    ctx.globalAlpha = 1;
  }
  // Glows and sparks add light (on a transparent overlay that brightens whatever is behind it).
  function drawImpacts(now, dt) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = glows.length - 1; i >= 0; i--) {
      const g = glows[i], t = (now - g.born) / g.life;
      if (t >= 1 || !players.has(g.owner.key)) { glows.splice(i, 1); continue; }
      const x = g.owner.x, y = height - FLOOR - g.owner.lane + g.y, r = g.r * (.7 + .3 * t);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(.2, g.color); grad.addColorStop(1, g.color + '00');
      ctx.globalAlpha = .75 * (1 - t) ** 2;
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.lineCap = 'square';
    for (let i = sparks.length - 1; i >= 0; i--) {
      const k = sparks[i], o = k.owner, age = now - k.born;
      if (age > k.life || !players.has(o.key)) { sparks.splice(i, 1); continue; }
      if (o.stopUntil && now >= o.stopStart && now < o.stopUntil) k.born += dt * 1000;   // hit stop: hold still, don't age
      else { k.vy += 900 * dt; k.vx *= 1 - 3 * dt; k.vy *= 1 - 3 * dt; k.x += k.vx * dt; k.y += k.vy * dt; }
      const x = k.x, y = height - FLOOR - o.lane + k.y, f = 1 - age / k.life;
      ctx.globalAlpha = f;
      ctx.strokeStyle = k.color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - k.vx * .035, y - k.vy * .035); ctx.stroke();
      if (f > .5) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - k.vx * .015, y - k.vy * .015); ctx.stroke(); }
    }
    ctx.restore();
  }
  function drawAnnouncement() {
    const lines = liveAnnouncements();
    if (!lines.length || announce === 'off') return;
    const above = height - FLOOR - 28 - size * DUEL_GROW - 150 - 64;   // clear of the win banner and the fighters
    ctx.save();
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    lines.forEach((line, i) => {
      const top = announce === 'bottom' ? Math.max(8, above - (lines.length - 1 - i) * 56) : 26 + i * 56;
      const boxWidth = Math.min(width - 24, Math.max(260, ctx.measureText(line.text).width + 40));
      const left = (width - boxWidth) / 2;
      ctx.fillStyle = 'rgba(12,16,25,.82)';
      ctx.fillRect(left, top, boxWidth, 48);
      ctx.strokeStyle = 'rgba(255,255,255,.2)';
      ctx.strokeRect(left, top, boxWidth, 48);
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, width / 2, top + 33, boxWidth - 24);
    });
    ctx.restore();
  }
  // Picks the animation for the current action. Characters without drawn attack/ko frames
  // (combatFallback "effects", or a single-PNG custom character) get engine-driven motion instead.
  function frameFor(sprite, p, now, moving) {
    const a = sprite.animations || {};
    const anim = p.anim && now < p.anim.until ? p.anim : null;
    const pick = (list, hold) => {
      if (hold) return list[Math.max(0, Math.min(list.length - 1, Math.floor((now - (p.koStart || now)) / 1000 * sprite.fps)))];
      return list[Math.floor((now + p.phase) / 1000 * sprite.fps) % list.length];
    };
    // "effects" characters only have an upright hurt frame for ko, so the engine still tips them over.
    if (p.koUntil > now && a.ko) return { frame: pick(a.ko, true), drawn: sprite.combatFallback !== 'effects' };
    if (anim?.kind === 'attack' && a.attack) return { frame: a.attack[Math.max(0, Math.min(a.attack.length - 1, Math.floor((now - anim.start) / (anim.until - anim.start) * a.attack.length)))], drawn: true };
    if (anim?.kind === 'cheer' && a.cheer) return { frame: pick(a.cheer), drawn: true };
    if (p.vy < 0 && a.jump) return { frame: a.jump[0], drawn: true };
    if (moving) return { frame: pick(a.walk || sprite.frames) };
    return { frame: pick(a.idle || sprite.frames) };
  }
  // Distance between the two fighters of a duel when there is room: two grown fighters and their nameplates.
  // With several duels at once placeMeet shrinks it (down to duelGapMin) so the health bars never collide.
  const duelGap = () => Math.max(size * 2, 190);
  const duelGapMin = () => Math.min(duelGap(), Math.max(96, size * DUEL_GROW));
  const barBase = s => Math.max(72, Math.min(116, s * 0.9));   // the hp bar; its "100/100" text (16px bold) is narrower than the minimum
  // Bars shrink (to 64 px at the least) only when neighbouring duels are packed so close that full bars would touch:
  // the clear space between two neighbouring meeting points' inner fighters, or inside one duel, bounds the width.
  function barWidthOf(s) {
    const base = barBase(s), xs = [...meetPoints.values()].sort((p, q) => p.x - q.x);
    let room = Infinity;
    for (let i = 0; i < xs.length; i++) {
      room = Math.min(room, xs[i].gap - 8);
      if (i) room = Math.min(room, xs[i].x - xs[i - 1].x - (xs[i].gap + xs[i - 1].gap) / 2 - 8);
    }
    return Math.max(64, Math.min(base, room));
  }
  // Hit stop: a fighter's animation clock pauses while a blow lands, then the animation carries on where it stopped.
  function animClock(p, clock) {
    if (!p.stopUntil || clock < p.stopStart) return clock;
    if (clock < p.stopUntil) return p.stopStart;
    if (p.anim && p.anim.until > p.stopStart) { const d = p.stopUntil - p.stopStart; p.anim = { ...p.anim, start: p.anim.start + d, until: p.anim.until + d }; }
    p.stopUntil = 0;
    return clock;
  }
  // Several duels can run at once, so each gets its own meeting point with its own gap. Two neighbouring duels need
  // their inner fighters' hp bars (and dice) clear of each other. At full gap that is a comfortable slot (two gaps and a
  // fighter, as always); when the spot runs out the gap shrinks a little at a time, down to duelGapMin, which also
  // tightens the slot to just bar width plus a margin. Searches outward from the midpoint, nearest free spot wins.
  function placeMeet(mid) {
    const full = duelGap(), least = duelGapMin(), clearBars = barBase(size * DUEL_GROW) + 16;
    const taken = [...meetPoints.values()];
    let best = { x: mid, gap: least };
    for (let gap = full; ; gap = Math.max(least, gap - 8)) {
      const comfort = full > least ? (gap - least) / (full - least) * (full + size - clearBars) : 0;
      const lo = gap, hi = Math.max(gap, width - gap), clamp = x => Math.max(lo, Math.min(hi, x));
      const slack = x => taken.length ? Math.min(...taken.map(t => Math.abs(t.x - x) - ((t.gap + gap) / 2 + clearBars + comfort))) : Infinity;
      let bestSlack = -Infinity;
      for (let k = 0; k <= Math.ceil(width / 12) + 1; k++) {
        for (const x of k ? [clamp(mid + k * 12), clamp(mid - k * 12)] : [clamp(mid)]) {
          const s = slack(x);
          if (s >= 0) return { x, gap };
          if (s > bestSlack) { bestSlack = s; best = { x, gap }; }
        }
      }
      if (gap === least) break;
    }
    // No free spot even at the smallest gap, because duels placed earlier left only fragments. Pack every meeting
    // point at the smallest gap, in order along the stage, spread as far apart as the stage allows (existing duels
    // walk a little to their new spot). Past that the health bars shrink (barWidthOf), never overlap.
    const items = [...meetPoints.values()].map(m => ({ m, x: m.x })), fresh = { m: null, x: best.x };
    items.push(fresh);
    items.sort((p, q) => p.x - q.x);
    const lo = least, hi = Math.max(least, width - least), step = items.length > 1 ? Math.min(least + clearBars, (hi - lo) / (items.length - 1)) : 0;
    let prev = -Infinity, next = Infinity;
    for (const it of items) { it.x = Math.max(lo, it.x, prev + step); prev = it.x; }
    for (let i = items.length - 1; i >= 0; i--) { items[i].x = Math.min(hi, items[i].x, next - step); next = items[i].x; }
    for (const it of items) if (it.m) { it.m.x = it.x; it.m.gap = least; it.m.speed = Math.max(it.m.speed || 110, 180); }
    return { x: fresh.x, gap: least };
  }
  // Nameplates and chat bubbles are laid out after every fighter has moved, so none of them overlap or leave the screen.
  // Nameplates: fighters in a duel first, then the most recent chatters; one that would cover a placed nameplate is
  // skipped this frame (it shows again once the walkers separate). Bubbles: the oldest keeps its spot, newer ones stack
  // up to three high above it, clear of duel health bars.
  const LABEL_ROW = 20, TITLE_ROW = 16, BUBBLE_H = 25;
  const nameColors = new Map();   // chat color -> readable nameplate color (readableColor lifts dark ones), computed once per color
  const nameColor = color => {
    let out = nameColors.get(color);
    if (out === undefined) { if (nameColors.size > 500) nameColors.clear(); out = readableColor(color); nameColors.set(color, out); }
    return out;
  };
  const overlaps = (a, b) => a.lo < b.hi && a.hi > b.lo && a.top < b.bottom && a.bottom > b.top;
  function drawLabels(labels, bubbles, bars) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px system-ui, sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
    const placed = [];
    for (const l of labels.sort((a, b) => b.rank - a.rank)) {
      const x = Math.max(l.w / 2 + 4, Math.min(width - l.w / 2 - 4, l.x));
      if (l.title) l.y = Math.min(l.y, height - TITLE_ROW - 5);   // a fighter on a low lane lifts its nameplate so the title stays on screen
      const box = { lo: x - l.w / 2 - 4, hi: x + l.w / 2 + 4, top: l.y - LABEL_ROW + 2, bottom: l.y + 2 + (l.title ? TITLE_ROW : 0) };
      if (placed.some(o => overlaps(box, o))) continue;
      placed.push(box);
      ctx.fillStyle = l.color; ctx.strokeText(l.text, x, l.y); ctx.fillText(l.text, x, l.y);
      if (l.title) {   // a bought title, in a smaller line under the name
        ctx.font = 'bold 14px system-ui, sans-serif'; ctx.lineWidth = 3;
        ctx.fillStyle = '#fde68a'; ctx.strokeText(l.title, x, l.y + TITLE_ROW); ctx.fillText(l.title, x, l.y + TITLE_ROW);
        ctx.font = 'bold 20px system-ui, sans-serif'; ctx.lineWidth = 4;
      }
    }
    ctx.font = 'bold 14px system-ui, sans-serif';
    const stacked = [...bars];
    for (const b of bubbles.sort((a, c) => a.until - c.until)) {
      const x = Math.max(b.w / 2, Math.min(width - b.w / 2, b.x));
      for (let level = 0; level < 3; level++) {
        const top = b.top - level * (BUBBLE_H + 4), box = { lo: x - b.w / 2 - 2, hi: x + b.w / 2 + 2, top, bottom: top + BUBBLE_H };
        if (stacked.some(o => overlaps(box, o))) continue;
        stacked.push(box);
        ctx.fillStyle = 'rgba(18,18,26,.88)'; ctx.fillRect(x - b.w / 2, top, b.w, BUBBLE_H);
        ctx.fillStyle = '#ffffff'; ctx.fillText(b.text, x, top + 18, Math.max(1, b.w - 8));
        break;
      }
    }
    ctx.restore();
  }
  // The demo embedded on the site (?demo=1) draws at 30 fps and stops while its page scrolls it out of view
  // (the page posts { demoPaused }); the overlay on stream keeps the full frame rate.
  let demoPaused = false, drawing = true;
  if (demo) addEventListener('message', (e) => {
    if (e.origin !== location.origin || typeof e.data?.demoPaused !== 'boolean') return;
    demoPaused = e.data.demoPaused;
    if (!demoPaused && !drawing) { drawing = true; lastFrame = performance.now(); requestAnimationFrame(draw); }
  });
  function draw(now) {
    if (demoPaused) { drawing = false; return; }
    if (demo && now - lastFrame < 30) { requestAnimationFrame(draw); return; }
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
    const clock = Date.now();
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    if (shake && clock < shake.until) {
      const m = shake.mag * (shake.until - clock) / (shake.until - shake.start);
      ctx.translate((Math.random() - .5) * 2 * m, (Math.random() - .5) * 2 * m);
    }
    const zoom = pushZoom(clock);
    if (zoom !== 1) { ctx.translate(push.x, push.y); ctx.scale(zoom, zoom); ctx.translate(-push.x, -push.y); }
    if (clock - lastCleanup > 1000) {
      for (const [key, p] of players) if (!p.fromArena && clock - p.lastSeen > 600000) players.delete(key);
      lastCleanup = clock; updateStatus();
    }
    const labels = [], bubbles = [], bars = [], wins = [];
    trail.draw(ctx, clock);   // behind every fighter
    // Ground taken by running duels: where the two fighters stand, plus room for their nameplates (fixed 20px
    // text, often wider than the sprite). labelWidth is measured when the nameplate is drawn (last frame).
    const duelZones = openDuels().filter(d => meetPoints.has(d.id)).map(d => ({ x: meetPoints.get(d.id).x, gap: meetPoints.get(d.id).gap,
      label: Math.max(findPlayer(String(d.a))?.labelWidth || 0, findPlayer(String(d.b))?.labelWidth || 0) }));
    for (const p of players.values()) {
      const duel = duelFor(p);
      const opponent = duel ? findPlayer(String(duel.a) === p.userId ? duel.b : duel.a) : null;
      const ko = p.koUntil > clock;
      let moving = false;
      if (duel?.status === 'active' && opponent) {
        // Duels happen where the characters stand: both walk to the midpoint between them and face each other.
        let meet = meetPoints.get(duel.id);
        if (!meet) {
          const a = findPlayer(duel.a) || p, b = findPlayer(duel.b) || opponent;
          meet = { ...placeMeet((a.x + b.x) / 2), aLeft: a.x <= b.x };
          meetPoints.set(duel.id, meet);
        }
        const isA = String(duel.a) === p.userId;
        const target = meet.x + ((isA === meet.aLeft) ? -meet.gap / 2 : meet.gap / 2);
        const diff = target - p.x;
        if (Math.abs(diff) > 2) { p.x += Math.sign(diff) * Math.min(Math.abs(diff), (meet.speed || 110) * dt); moving = true; p.direction = Math.sign(diff); }
        else p.direction = opponent.x >= p.x ? 1 : -1;
      } else if (duel?.status === 'pending' && opponent) {
        p.direction = opponent.x >= p.x ? 1 : -1;
      } else if (!ko && !(p.holdUntil > clock)) {
        // Personal space: a walker about to run into a neighbour's nameplate turns around (at most every 1.5 s, so
        // a dense crowd doesn't jitter). Fighters in different lanes have nameplates at different heights and pass.
        if (clock - (p.turnedAt || 0) > 1500) {
          for (const q of players.values()) {
            if (q === p || q.koUntil > clock || Math.abs(q.lane - p.lane) >= LABEL_ROW) continue;
            const dx = q.x - p.x;
            if (Math.sign(dx) === p.direction && Math.abs(dx) < ((p.labelWidth || size) + (q.labelWidth || size)) / 2 + 12) { p.direction = -p.direction; p.turnedAt = clock; break; }
          }
        }
        p.x += p.speed * p.direction * dt;
        moving = true;
      }
      const left = Math.min(size / 2, width / 2), right = Math.max(left, width - size / 2);
      if (duel?.status !== 'active' && !ko) {
        // A bystander who walks into a duel turns back; one already inside walks out the nearer open side.
        const zone = duelZones.map(z => {
          const half = z.gap / 2 + Math.max(size * DUEL_GROW / 2 + size / 2, (z.label + (p.labelWidth || 0)) / 2 + 12);
          return { lo: z.x - half, hi: z.x + half };
        }).find(z => p.x > z.lo && p.x < z.hi);
        if (zone && (zone.lo >= left || zone.hi <= right)) {
          const out = zone.hi > right || (zone.lo >= left && p.x - zone.lo < zone.hi - p.x) ? -1 : 1;
          p.direction = out;
          p.x += out * Math.max(p.speed, 90) * dt;
          moving = true;
        }
      }
      if (p.x < left) { p.x = left; p.direction = 1; }
      if (p.x > right) { p.x = right; p.direction = -1; }
      p.vy += 750 * dt; p.y += p.vy * dt;
      if (p.y >= 0) { p.y = 0; p.vy = 0; }
      const y = height - FLOOR - p.lane + p.y;
      const grow = duel?.status === 'active' || p.bigUntil > clock ? DUEL_GROW : 1;
      p.grow = (p.grow || 1) + (grow - (p.grow || 1)) * Math.min(1, dt * 6);
      const s = size * p.grow;
      const sprite = sprites.get(p.renderAvatar) || sprites.get(p.avatar);
      const ac = animClock(p, clock);
      const anim = p.anim && ac < p.anim.until ? p.anim : null;
      const progress = anim ? (ac - anim.start) / (anim.until - anim.start) : 0;
      // Lunge for attacks, knockback for hits; both are fallbacks that also run on top of drawn frames.
      let offset = 0;
      if (anim?.kind === 'attack' && progress > 0) offset = Math.sin(progress * Math.PI) * s * (anim.heavy ? .45 : .3) * p.direction;
      if (anim?.kind === 'hit' && progress > 0) offset = -Math.sin(progress * Math.PI) * s * (anim.heavy ? .3 : .16) * p.direction;
      if (anim?.kind === 'dodge' && progress > 0) offset = -Math.sin(progress * Math.PI) * s * .4 * p.direction;
      // The pet trots behind its fighter, facing the same way; it is drawn first so the fighter stays in front.
      if (p.pet) {
        drawPet(ctx, petArt(p.pet), p.x - p.direction * s * .55, y, s * .42, { facing: p.direction, t: clock + p.phase, moving, tier: p.petTier, tint: recolorFilter(p.petColor) || 'none' });
      }
      if (p.trail && moving && !ko) trail.spawn(p.key, p.trail, p.x, y, s, p.direction, clock);
      ctx.save();
      if (sprite?.loaded) {
        const { frame, drawn } = frameFor(sprite, p, ac, moving);
        const single = sprite.mode === 'single' || sprite.frames.length === 1;
        const bob = single && moving ? Math.abs(Math.sin((clock + p.phase) / 140)) * s * .06 : 0;
        const squash = single && moving ? 1 + Math.sin((clock + p.phase) / 70) * .04 : 1;
        const drawHeight = s * (sprite.fit || 1), drawWidth = drawHeight * frame.w / frame.h;
        ctx.translate(p.x + offset, y - bob);
        if (ko && !drawn) {
          const fall = Math.min(1, (clock - (p.koStart || clock - 400)) / 400);
          ctx.globalAlpha = .55;
          ctx.rotate(-p.direction * fall * Math.PI / 2);
        }
        const flash = anim?.kind === 'hit' && progress > 0 && progress < .6 ? 'brightness(2.2) saturate(0.4)'
          : anim?.kind === 'attack' && !drawn && progress > 0 ? 'brightness(1.35)' : '';
        // Sources face right; mirror left walking.
        ctx.scale(p.direction / squash, squash);
        const look = { headHint: sprite.head, t: clock + p.phase, moving };
        // The recolor tints the body only (a cached tinted frame); the brief hit flash covers everything. A cape
        // hangs behind the body.
        ctx.filter = flash || 'none';
        if (p.accessory) drawAccessory(ctx, p.accessory, sprite.image, frame, -drawWidth / 2, -drawHeight, drawWidth, drawHeight, { ...look, layer: 'back' });
        const body = recoloredFrame(sprite.image, frame, p.recolor);
        if (body) ctx.drawImage(body, 0, 0, body.width, body.height, -drawWidth / 2, -drawHeight, drawWidth, drawHeight);
        else ctx.drawImage(sprite.image, frame.x, frame.y, frame.w, frame.h, -drawWidth / 2, -drawHeight, drawWidth, drawHeight);
        if (p.hat) drawHat(ctx, p.hat, sprite.image, frame, -drawWidth / 2, -drawHeight, drawWidth, drawHeight, sprite.head);
        if (p.accessory) drawAccessory(ctx, p.accessory, sprite.image, frame, -drawWidth / 2, -drawHeight, drawWidth, drawHeight, look);
      } else {
        if (ko) ctx.globalAlpha = .5;
        ctx.translate(p.x + offset, y); ctx.scale(p.grow, p.grow);
        drawFallback(p, 0, 0, now);
      }
      ctx.restore();
      drawEffects(p, p.x, y, clock, s, ac);
      const health = healthOf(p, duel);
      if (health) {
        drawHealthBar(p, p.x, y, health, s);
        const half = barWidthOf(s) / 2 + 4;   // the bar and its "hp/max" text: bubbles stay clear
        bars.push({ lo: p.x - half, hi: p.x + half, top: y - s - 40, bottom: y - s - 8 });
      }
      ctx.font = 'bold 20px system-ui, sans-serif';
      const shownElo = replayRatings(p.userId)?.before ?? p.arenaProfile?.elo;
      const rankedLabel = p.arenaProfile?.registered && Number.isFinite(Number(shownElo))
        ? p.label + ' · ' + Math.round(Number(shownElo))
        : p.label;
      p.labelWidth = ctx.measureText(rankedLabel).width;
      labels.push({ text: rankedLabel, color: nameColor(p.color), x: p.x, y: y + 23, w: p.labelWidth, rank: duel ? Infinity : p.lastSeen, title: p.arenaProfile?.registered ? TITLES[p.title] || '' : '' });
      if (p.winFx && clock - p.winFx.start < WIN_EFFECT_MS) wins.push({ fx: p.winFx, x: p.x, y, s });
      else p.winFx = null;
      if (p.text && clock < p.bubbleUntil && !health) {
        ctx.font = 'bold 14px system-ui, sans-serif';
        if (p.shortFor !== p.text) { p.shortFor = p.text; p.short = truncateText(p.text, 38, '…'); }   // cut once per message, by whole characters
        const text = p.short;
        bubbles.push({ text, x: p.x, top: y - s - 33, w: Math.min(width, ctx.measureText(text).width + 16), until: p.bubbleUntil });
      }
    }
    drawLabels(labels, bubbles, bars);
    drawParticles(clock, dt);
    drawImpacts(clock, dt);
    for (const w of wins) drawWinEffect(ctx, w.fx.id, w.x, w.y, w.s, (clock - w.fx.start) / WIN_EFFECT_MS, w.fx.seed);
    drawBanners(clock);
    ctx.restore();
    drawAnnouncement();
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  // Local-only preview of a duel, shaped like real server snapshots and events. Nothing is saved.
  function setupDemoArena() {
    const demoProfiles = [
      ['Ness', 'toon-ranger', '#fb923c', 'heavy', 1220],
      ['Sunny', 'female', '#60a5fa', 'strike', 1184],
      ['Mochi', 'toon-robot', '#f472b6', 'heal', 1108],
      ['Cloud', 'soldier', '#a78bfa', 'strike', 1060],
      ['Pixel', 'alien-green', '#4ade80', 'heavy', 1012],
      ['Bean', 'adventurer', '#facc15', 'strike', 980],
      ['Luna', 'toon-scout', '#e879f9', 'heal', 940],
      ['Sprout', 'player', '#34d399', 'strike', 900],
    ].map(([displayName, avatar, color, defaultAbility, elo], index) => ({
      userId: 'demo-' + index, username: displayName.toLowerCase(), displayName, registered: true,
      avatar, color, defaultAbility, hp: 100, elo, wins: index % 4, losses: index % 3, lastSeen: Date.now(), respawnAt: 0,
      hat: ['crown', 'cap', 'halo', 'tophat', 'horns', 'wizard', 'beanie', 'bandana'][index],
      pet: ['dragon', 'fox', 'cat', '', 'owl', 'slime', 'phoenix', 'frog'][index],
      petTier: ['legendary', 'rare', 'uncommon', '', 'epic', 'common', 'legendary', 'uncommon'][index],
      recolor: ['', '', 'violet', '', '', 'gold', '', ''][index],
      petColor: ['', 'ocean', '', '', '', '', '', 'crimson'][index],
      accessory: ['cape', 'glasses', '', 'shades', '', 'scarf', 'monocle', 'bowtie'][index],
      trail: ['flames', '', 'hearts', '', 'sparkles', '', 'notes', ''][index],
      winEffect: ['fireworks', 'confetti', 'banner', 'confetti', 'fireworks', 'banner', 'confetti', 'banner'][index],
      taunt: ['gg', 'easy', 'next', 'bow', 'rematch', 'nap', 'luck', 'chat'][index],
      title: ['legend', 'champion', 'lucky', 'wall', '', 'menace', 'owl', 'rookie'][index],
    }));
    arenaTransport = 'demo';
    arenaChat = { connected: true, lastSeen: Date.now(), status: 'enabled' };
    let revision = 1, round = 0, seq = 0, duel = null, lastPair = '', nextAt = Date.now() + 1500;
    const snapshot = () => acceptArenaSnapshot({ channel, revision: ++revision, paused: false, chat: { connected: true, lastSeen: Date.now(), status: 'enabled' }, config: { maxHp: 100 }, players: demoProfiles, duels: duel ? [duel] : [], events: [] }, { revision });
    const event = fields => ({ id: 'demo-' + revision + '-' + (++seq), at: Date.now(), ...fields });
    snapshot();
    if (debug) {   // the demo label is for testing only; on stream the demo looks like the real overlay
      const badge = document.createElement('div');
      badge.id = 'arena-mode';
      badge.textContent = 'DEMO · local match · not saved';
      Object.assign(badge.style, {
        position: 'fixed', top: '12px', right: '12px', zIndex: '2', padding: '7px 10px',
        borderRadius: '4px', color: '#fff', background: 'rgba(12,16,25,.82)',
        font: '600 11px system-ui,sans-serif', pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    }
    // The same rules as the server's quick duel (settleQuickDuel in server/game.js): one d6 per swing, 6 crits for 50,
    // 5 hits for 34, 3-4 misses, 1-2 is countered for 34. After 12 rolls more HP wins, a tie goes to sudden death.
    // Like a real !fight, the whole duel arrives at once (settled snapshot plus events) and the overlay replays it.
    function quickDuel() {
      round++;
      let a, b;
      do {
        const pool = [...demoProfiles];
        a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        b = pool[Math.floor(Math.random() * pool.length)];
      } while ([a.userId, b.userId].sort().join() === lastPair);
      lastPair = [a.userId, b.userId].sort().join();
      const id = 'demo-duel-' + round, hp = { [a.userId]: 100, [b.userId]: 100 };
      const events = [event({ type: 'duel_started', duelId: id, a: a.userId, b: b.userId, round, hp: { ...hp } })];
      let attacker = a, defender = b, winner = null, loser = null, decision = 'ko';
      for (let i = 0; !winner && i < 200; i++) {
        const suddenDeath = i >= 12;
        if (i === 12) {
          if (hp[a.userId] !== hp[b.userId]) { decision = 'hp'; [winner, loser] = hp[a.userId] > hp[b.userId] ? [a, b] : [b, a]; break; }
          decision = 'sudden_death';
        }
        const die = 1 + Math.floor(Math.random() * 6);
        if (die === 3 || die === 4) {
          events.push(event({ type: 'duel_action', duelId: id, userId: attacker.userId, targetId: defender.userId, ability: attacker.defaultAbility, amount: 0, hp: { ...hp }, miss: true, die }));
        } else {
          const counter = die <= 2, dealer = counter ? defender : attacker, target = counter ? attacker : defender;
          const amount = suddenDeath ? hp[target.userId] : Math.min(hp[target.userId], die === 6 ? 50 : 34);
          hp[target.userId] -= amount;
          const finisher = hp[target.userId] <= 0;
          events.push(event({ type: 'duel_action', duelId: id, userId: dealer.userId, targetId: target.userId, ability: dealer.defaultAbility, amount, hp: { ...hp }, die,
            ...(counter ? { counter: true } : {}), ...(die === 6 ? { crit: true } : {}), ...(finisher ? { finisher: true } : {}) }));
          if (finisher) { winner = dealer; loser = target; }
        }
        [attacker, defender] = [defender, attacker];
      }
      const flawless = hp[winner.userId] === 100, expectedA = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400)), scoreA = winner === a ? 1 : 0;
      const next = { [a.userId]: Math.round(a.elo + 24 * (scoreA - expectedA)), [b.userId]: Math.round(b.elo + 24 * (expectedA - scoreA)) };
      if (flawless) next[winner.userId] += 3;
      const ratings = {};
      for (const f of [a, b]) { ratings[f.userId] = { before: f.elo, after: next[f.userId], delta: next[f.userId] - f.elo }; f.elo = next[f.userId]; }
      winner.wins++; loser.losses++;
      for (const f of demoProfiles) f.respawnAt = 0;
      loser.respawnAt = Date.now() + 5000;
      const flags = { ...(flawless ? { flawless: true } : {}), ...(decision !== 'ko' ? { decision } : {}) };
      duel = { id, a: a.userId, b: b.userId, status: 'completed', round, winnerId: winner.userId, hp, ratings, rules: { maxHp: 100 }, ...flags };
      events.push(event({ type: 'duel_completed', duelId: id, winnerId: winner.userId, loserId: loser.userId, round, respawnAt: loser.respawnAt, hp: { ...hp }, ratings, ...flags }));
      snapshot();
      events.forEach(queueArenaEvent);
    }
    // The next duel starts a few seconds after the last replay ends, once the knockout and the result have played.
    arenaTimer = setInterval(() => {
      if (duelQueues.size || replays.size) { nextAt = Date.now() + 3500; return; }
      if (Date.now() >= nextAt) quickDuel();
    }, 250);
  }
  function startArena() {
    if (arenaDemo) { setupDemoArena(); return; }
    arenaClient = createArenaClient({
      channel,
      role: 'overlay',
      onSnapshot: acceptArenaSnapshot,
      onEvent: queueArenaEvent,
      onStatus(event) {
        arenaTransport = event.state || 'offline';
        if (event.chat) arenaChat = event.chat;
        updateStatus(event.message || '');
      },
    });
  }
  if (arenaEnabled) startArena();
  let chat;
  if (demo) {
    const names = ['Ness', 'Sunny', 'Mochi', 'Cloud', 'Pixel', 'Bean', 'Luna', 'Sprout'];
    names.forEach((name, i) => onMessage({ username: name, displayName: name, userId: arenaDemo ? 'demo-' + i : String(i), text: 'Hello!' }));
    const timer = setInterval(() => {
      const name = names[Math.floor(Math.random() * names.length)];
      const texts = ['Hi chat!', '!jump', 'That was amazing', '!color #f9a8d4', ids.length ? '!avatar ' + ids[Math.floor(Math.random() * ids.length)] : 'Let’s go!'];
      onMessage({ username: name, displayName: name, text: texts[Math.floor(Math.random() * texts.length)] });
    }, 1800);
    chat = { disconnect() { clearInterval(timer); } };
  } else {
    chat = connectChat(channel, { onMessage, onModeration, onStatus(event) { connectionState = event.state; updateStatus(event.message || ''); } });
  }
  addEventListener('pagehide', () => {
    chat?.disconnect();
    arenaClient?.disconnect();
    clearInterval(arenaTimer);
  }, { once: true });
  if (debug && arenaEnabled) {
    window.__arenaMove = (userId, x) => { const p = findPlayer(String(userId)); if (p) p.x = x; };   // tests: place fighters
    window.__arenaDebug = () => ({
      revision: arenaRevision,
      paused: arenaPaused,
      chat: arenaChat,
      profiles: profilesById.size,
      duels: arenaDuels,
      replays: [...replays.values()],
      players: [...players.values()].map(p => ({ userId: p.userId, label: p.label, color: p.color, nameColor: nameColor(p.color), avatar: p.renderAvatar, elo: p.arenaProfile?.elo, shownElo: replayRatings(p.userId)?.before ?? p.arenaProfile?.elo,
        x: Math.round(p.x), ko: p.koUntil > Date.now(), anim: p.anim && Date.now() < p.anim.until ? p.anim.kind : '',
        grow: Math.round((p.grow || 1) * 100) / 100, die: p.die && Date.now() < p.die.until ? p.die.value : 0, float: p.floatText && Date.now() < p.floatText.until ? p.floatText.text : '',
        bubble: p.text && Date.now() < p.bubbleUntil ? p.text : '' })),
      announce, cap, build: firstBuild, staleBuild, fx: fxOn ? 'on' : 'off', glows: glows.length, sparks: sparks.length, push: !!push,
      announcement: liveAnnouncements().map(a => a.text).join(' | '),
      meets: [...meetPoints.values()].map(m => Math.round(m.x)),
      gaps: [...meetPoints.values()].map(m => Math.round(m.gap)),
      ownVersion, buildChanged,
      banners: banners.filter(b => Date.now() < b.until).map(b => b.text),
      results: results.map(r => ({ ...r })),
    });
  }
  updateStatus();
}
if (typeof document !== 'undefined') start().catch(error => {
  const status = document.querySelector('#status');
  if (status) { status.hidden = false; status.textContent = 'Overlay error: ' + error.message; }
});
