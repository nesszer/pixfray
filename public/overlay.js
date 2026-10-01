import { connectChat } from './chat.js';
import { createArenaClient } from './arena-client.js';

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

// Arena events (CONTRACTS.md section 3) older than this are history from the first snapshot, not news.
const EVENT_FRESH_MS = 10_000;
const OPEN = new Set(['pending', 'active']);
const CANCEL_TEXT = {
  inactivity: 'no action for a while', chat_disconnected: 'chat offline',
  duels_disabled: 'duels turned off', moderator_cancelled: 'cancelled by a moderator', moderator_reset: 'reset by a moderator',
  player_removed: 'player removed',
};

async function start() {
  const canvas = document.querySelector('#stage');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const params = new URLSearchParams(location.search);
  const channel = (params.get('channel') || 'nesszerra').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25) || 'nesszerra';
  const demo = params.get('demo') === '1';
  const arenaEnabled = params.get('arena') === '1';
  const arenaDemo = arenaEnabled && demo;
  const debug = params.get('debug') === '1';
  const cap = Math.max(1, Math.min(100, Number(params.get('cap')) || 100));
  const size = Math.max(24, Math.min(96, Number(params.get('size')) || 60));
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
  const meetPoints = new Map();
  let width = 1, height = 1, connectionState = demo ? 'demo' : 'connecting';
  let arenaChat = null, arenaTransport = arenaDemo ? 'demo' : 'connecting', arenaConfig = { maxHp: 100 };
  let arenaRevision = null, arenaDuels = [], arenaClient = null, arenaTimer = null, arenaPaused = false;
  let announcement = null, lastCatalogFetch = 0;
  const missingAvatars = new Set();
  let lastFrame = performance.now(), lastCleanup = 0;
  const particles = [];
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
    } else if (arenaEnabled && !arenaDemo && (!chatOnline || arenaPaused)) {
      status.textContent = chatOnline ? 'Duels paused' : 'Duels paused · chat offline';
      status.hidden = false;
    } else {
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
    return String(profile?.displayName || profile?.username || 'Player').slice(0, 24);
  };
  function openDuels() { return arenaDuels.filter(duel => OPEN.has(duel?.status)); }
  function findPlayer(userId) {
    if (userId === null || userId === undefined || userId === '') return null;
    for (const p of players.values()) if (p.userId === String(userId)) return p;
    return null;
  }
  function spawn(key, init) {
    if (players.size >= cap) {
      const oldest = [...players.values()].reduce((a, b) => a.lastSeen < b.lastSeen ? a : b);
      players.delete(oldest.key);
    }
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
  function applyArenaProfile(p) {
    const profile = arenaEnabled && p.userId ? profilesById.get(p.userId) : null;
    p.arenaProfile = profile || null;
    p.renderAvatar = p.avatar;
    p.defaultAbility = '';
    if (!profile) return;
    if (profile.displayName || profile.username) p.label = String(profile.displayName || profile.username).slice(0, 24);
    if (!profile.registered) return;
    p.color = sanitizeColor(profile.color) || p.chatColor || p.color;
    const avatar = typeof profile.avatar === 'string' ? profile.avatar.toLowerCase() : '';
    if (sprites.has(avatar)) p.renderAvatar = avatar;
    // A newly seen id (fresh upload) refetches at once; ids that stay unknown retry at most every 30 s.
    else if (avatar && !arenaDemo && (!missingAvatars.has(avatar) || Date.now() - lastCatalogFetch > 30_000) && missingAvatars.add(avatar)) void loadArenaCatalog().then(() => { for (const q of players.values()) applyArenaProfile(q); });
    p.defaultAbility = String(profile.defaultAbility || '').slice(0, 20);
  }
  function acceptArenaSnapshot(snapshot, metadata = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    arenaChat = snapshot.chat && typeof snapshot.chat === 'object' ? snapshot.chat : null;
    if (snapshot.config && typeof snapshot.config === 'object') arenaConfig = snapshot.config;
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
    for (const [userId, profile] of profilesById) {
      if (findPlayer(userId)) continue;
      const key = String(profile.username || 'id:' + userId).toLowerCase().slice(0, 64);
      const existing = players.get(key);
      if (existing) { existing.userId = userId; continue; }
      spawn(key, { userId, fromArena: true, label: String(profile.displayName || key).slice(0, 24), chatLabel: String(profile.displayName || key).slice(0, 24) });
    }
    const now = Date.now();
    for (const p of players.values()) {
      applyArenaProfile(p);
      const respawnAt = Number(p.arenaProfile?.respawnAt) || 0;
      if (respawnAt > now && !(p.koUntil > now)) p.koStart = now;
      p.koUntil = respawnAt > now ? respawnAt : 0;
    }
    for (const id of meetPoints.keys()) if (!arenaDuels.some(duel => duel.id === id && duel.status === 'active')) meetPoints.delete(id);
    updateStatus();
  }
  function announceArena(text, color = '#fde68a') {
    if (text) announcement = { text: String(text).slice(0, 100), color, until: Date.now() + 5500 };
  }
  function burst(p, color, count, rise) {
    if (!p) return;
    for (let i = 0; i < count; i++) {
      particles.push({ x: p.x + (Math.random() - .5) * size * .5, y: -size * (.3 + Math.random() * .5), owner: p, color,
        vx: (Math.random() - .5) * 120, vy: rise ? -40 - Math.random() * 60 : -120 - Math.random() * 120, born: Date.now(), life: 700 });
    }
    if (particles.length > 300) particles.splice(0, particles.length - 300);
  }
  function floatText(p, text, color) { if (p) p.floatText = { text, color, until: Date.now() + 1200 }; }
  // Events of one duel that arrive together (a quick duel sends start, hit and KO at once) play one after another.
  const DUEL_EVENT_GAP_MS = { duel_started: 700, duel_action: 600 };
  const duelNextAt = new Map();
  function queueArenaEvent(event) {
    const id = event?.duelId;
    if (!id) return handleArenaEvent(event);
    const now = Date.now(), at = Math.max(now, duelNextAt.get(id) || 0);
    duelNextAt.set(id, at + (DUEL_EVENT_GAP_MS[event.type] || 0));
    if (duelNextAt.size > 50) duelNextAt.delete(duelNextAt.keys().next().value);
    if (at <= now) handleArenaEvent(event);
    else setTimeout(() => handleArenaEvent({ ...event, at: Number.isFinite(event.at) ? event.at + (at - now) : event.at }), at - now);
  }
  function handleArenaEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (Number.isFinite(event.at) && Date.now() - event.at > EVENT_FRESH_MS) return;
    const now = Date.now();
    switch (event.type) {
      case 'challenge_created':
        announceArena(nameOf(event.a) + ' challenges ' + nameOf(event.b) + ' to a duel');
        break;
      case 'challenge_declined':
        announceArena(nameOf(event.declinedBy) + ' declined the duel', '#e2e8f0');
        break;
      case 'challenge_expired':
        announceArena('Challenge to ' + nameOf(event.b) + ' expired', '#e2e8f0');
        break;
      case 'duel_started':
        announceArena('Round ' + event.round + ': ' + nameOf(event.a) + ' vs ' + nameOf(event.b));
        break;
      case 'duel_action': {
        const actor = findPlayer(event.userId), target = findPlayer(event.targetId);
        if (event.ability === 'heal') {
          if (actor) actor.anim = { kind: 'heal', start: now, until: now + 900 };
          burst(actor, '#4ade80', 10, true);
          floatText(actor, '+' + (Number(event.amount) || 0), '#4ade80');
        } else {
          if (actor) actor.anim = { kind: 'attack', heavy: event.ability === 'heavy', start: now, until: now + 450 };
          if (target) target.anim = { kind: 'hit', heavy: event.ability === 'heavy', start: now + 120, until: now + 520 };
          burst(target, event.ability === 'heavy' ? '#f97316' : '#fb7185', event.ability === 'heavy' ? 16 : 8, false);
          floatText(target, '-' + (Number(event.amount) || 0), '#fb7185');
        }
        break;
      }
      case 'duel_completed': {
        const winner = findPlayer(event.winnerId), loser = findPlayer(event.loserId);
        if (loser) { loser.koUntil = Number(event.respawnAt) || now + 3000; loser.koStart = now; }
        if (winner) { winner.anim = { kind: 'cheer', start: now, until: now + 1400 }; hop(winner, 220); }
        burst(loser, '#fbbf24', 18, false);
        const delta = event.ratings?.[event.winnerId]?.delta;
        announceArena(nameOf(event.winnerId) + ' wins' + (Number.isFinite(delta) ? ' · Elo +' + delta : '') + ' · ' + nameOf(event.loserId) + ' is knocked out', '#a7f3d0');
        break;
      }
      case 'duel_cancelled':
        announceArena('Duel cancelled · ' + (CANCEL_TEXT[event.reason] || 'not scored'), '#e2e8f0');
        break;
      case 'player_respawned': {
        const p = findPlayer(event.userId);
        if (p) { p.koUntil = 0; p.anim = { kind: 'respawn', start: now, until: now + 700 }; burst(p, '#bfdbfe', 10, true); }
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
    if (!username) return;
    const now = Date.now();
    let p = players.get(username) || (message.userId ? findPlayer(message.userId) : null);
    if (!p) p = spawn(username, { label: String(message.displayName || username).slice(0, 24), chatLabel: String(message.displayName || username).slice(0, 24) });
    if (message.userId !== undefined && message.userId !== null) p.userId = String(message.userId);
    if (message.displayName) p.chatLabel = String(message.displayName).slice(0, 24);
    if (sanitizeColor(message.color)) p.chatColor = sanitizeColor(message.color);
    if (!p.arenaProfile) {
      p.label = p.chatLabel || p.label;
      p.color = sanitizeColor(settings[username]?.color) || p.chatColor || p.color;
    }
    applyArenaProfile(p);
    const ranked = Boolean(p.arenaProfile?.registered);
    p.lastSeen = now; p.messageId = message.id || ''; p.text = String(message.text || '').slice(0, 72); p.bubbleUntil = now + 4000;
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
  function drawHealthBar(p, x, y, health) {
    const barWidth = Math.max(36, Math.min(58, size * 0.86));
    const left = x - barWidth / 2;
    const top = y - size - 13;
    const ratio = Math.max(0, Math.min(1, health.current / health.max));
    ctx.fillStyle = 'rgba(9,12,18,.86)';
    ctx.fillRect(left - 2, top - 2, barWidth + 4, 8);
    ctx.fillStyle = ratio > .55 ? '#4ade80' : ratio > .25 ? '#fbbf24' : '#fb7185';
    ctx.fillRect(left, top, barWidth * ratio, 4);
    ctx.strokeStyle = 'rgba(255,255,255,.72)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, barWidth, 4);
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,.9)';
    ctx.fillStyle = '#e2e8f0';
    const text = Math.round(health.current) + '/' + Math.round(health.max);
    ctx.strokeText(text, x, top - 4);
    ctx.fillText(text, x, top - 4);
  }
  function drawEffects(p, x, y, now) {
    const anim = p.anim && now < p.anim.until ? p.anim : null;
    if (anim && (anim.kind === 'heal' || anim.kind === 'hit' || anim.kind === 'respawn')) {
      const t = Math.max(0, Math.min(1, (now - anim.start) / (anim.until - anim.start)));
      const color = anim.kind === 'heal' ? '#4ade80' : anim.kind === 'hit' ? '#fb7185' : '#bfdbfe';
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y - size * .55, size * (.4 + t * .25), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (p.floatText && now < p.floatText.until) {
      const t = 1 - (p.floatText.until - now) / 1200;
      ctx.save();
      ctx.globalAlpha = Math.min(1, 2 - t * 2);
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.fillStyle = p.floatText.color;
      ctx.strokeText(p.floatText.text, x, y - size - 34 - t * 24);
      ctx.fillText(p.floatText.text, x, y - size - 34 - t * 24);
      ctx.restore();
    }
  }
  function drawParticles(now, dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const s = particles[i];
      const age = now - s.born;
      if (age > s.life || !players.has(s.owner.key)) { particles.splice(i, 1); continue; }
      s.vy += 380 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      ctx.globalAlpha = 1 - age / s.life;
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - 2, height - 22 - s.owner.lane + s.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }
  function drawAnnouncement() {
    if (!announcement || Date.now() >= announcement.until) return;
    ctx.save();
    ctx.font = '700 19px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const boxWidth = Math.min(width - 24, Math.max(230, ctx.measureText(announcement.text).width + 38));
    const left = (width - boxWidth) / 2;
    ctx.fillStyle = 'rgba(12,16,25,.82)';
    ctx.fillRect(left, 26, boxWidth, 40);
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.strokeRect(left, 26, boxWidth, 40);
    ctx.fillStyle = announcement.color;
    ctx.fillText(announcement.text, width / 2, 52, boxWidth - 24);
    ctx.restore();
  }
  // Picks the animation for the current action. Characters without drawn attack/ko frames
  // (combatFallback "effects", or a single-PNG custom character) get engine-driven motion instead.
  function frameFor(sprite, p, now, moving) {
    const a = sprite.animations || {};
    const anim = p.anim && now < p.anim.until ? p.anim : null;
    const pick = (list, hold) => {
      if (hold) return list[Math.min(list.length - 1, Math.floor((now - (p.koStart || now)) / 1000 * sprite.fps))];
      return list[Math.floor((now + p.phase) / 1000 * sprite.fps) % list.length];
    };
    if (p.koUntil > now && a.ko) return { frame: pick(a.ko, true), drawn: true };
    if (anim?.kind === 'attack' && a.attack) return { frame: a.attack[Math.min(a.attack.length - 1, Math.floor((now - anim.start) / (anim.until - anim.start) * a.attack.length))], drawn: true };
    if (anim?.kind === 'cheer' && a.cheer) return { frame: pick(a.cheer), drawn: true };
    if (p.vy < 0 && a.jump) return { frame: a.jump[0], drawn: true };
    if (moving) return { frame: pick(a.walk || sprite.frames) };
    return { frame: pick(a.idle || sprite.frames) };
  }
  // Up to 5 duels run at once: keep each duel's meeting point a full slot away from the others so
  // health bars and nameplates never overlap. Searches outward from the midpoint, nearest free spot wins.
  function freeMeetX(mid, gap) {
    const slot = gap * 2 + size, lo = gap, hi = Math.max(gap, width - gap);
    const taken = [...meetPoints.values()].map(m => m.x);
    const clamp = x => Math.max(lo, Math.min(hi, x));
    let best = clamp(mid), bestClearance = -1;
    for (let step = 0; step <= Math.ceil(width / slot) * 2; step++) {
      const x = clamp(mid + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * slot / 2);
      const clearance = taken.length ? Math.min(...taken.map(t => Math.abs(t - x))) : Infinity;
      if (clearance >= slot) return x;
      if (clearance > bestClearance) { best = x; bestClearance = clearance; }
    }
    return best;
  }
  function draw(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
    const clock = Date.now();
    ctx.clearRect(0, 0, width, height);
    if (clock - lastCleanup > 1000) {
      for (const [key, p] of players) if (!p.fromArena && clock - p.lastSeen > 600000) players.delete(key);
      lastCleanup = clock; updateStatus();
    }
    const gap = size * 1.15;
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
          meet = { x: freeMeetX((a.x + b.x) / 2, gap), aLeft: a.x <= b.x };
          meetPoints.set(duel.id, meet);
        }
        const isA = String(duel.a) === p.userId;
        const target = meet.x + ((isA === meet.aLeft) ? -gap / 2 : gap / 2);
        const diff = target - p.x;
        if (Math.abs(diff) > 2) { p.x += Math.sign(diff) * Math.min(Math.abs(diff), 110 * dt); moving = true; p.direction = Math.sign(diff); }
        else p.direction = opponent.x >= p.x ? 1 : -1;
      } else if (duel?.status === 'pending' && opponent) {
        p.direction = opponent.x >= p.x ? 1 : -1;
      } else if (!ko) {
        p.x += p.speed * p.direction * dt;
        moving = true;
      }
      const left = Math.min(size / 2, width / 2), right = Math.max(left, width - size / 2);
      if (p.x < left) { p.x = left; p.direction = 1; }
      if (p.x > right) { p.x = right; p.direction = -1; }
      p.vy += 750 * dt; p.y += p.vy * dt;
      if (p.y >= 0) { p.y = 0; p.vy = 0; }
      const y = height - 22 - p.lane + p.y;
      const sprite = sprites.get(p.renderAvatar) || sprites.get(p.avatar);
      const anim = p.anim && clock < p.anim.until ? p.anim : null;
      const progress = anim ? (clock - anim.start) / (anim.until - anim.start) : 0;
      // Lunge for attacks, knockback for hits; both are fallbacks that also run on top of drawn frames.
      let offset = 0;
      if (anim?.kind === 'attack' && progress > 0) offset = Math.sin(progress * Math.PI) * size * (anim.heavy ? .45 : .3) * p.direction;
      if (anim?.kind === 'hit' && progress > 0) offset = -Math.sin(progress * Math.PI) * size * (anim.heavy ? .3 : .16) * p.direction;
      ctx.save();
      if (sprite?.loaded) {
        const { frame, drawn } = frameFor(sprite, p, clock, moving);
        const single = sprite.mode === 'single' || sprite.frames.length === 1;
        const bob = single && moving ? Math.abs(Math.sin((clock + p.phase) / 140)) * size * .06 : 0;
        const squash = single && moving ? 1 + Math.sin((clock + p.phase) / 70) * .04 : 1;
        const drawWidth = size * frame.w / frame.h;
        ctx.translate(p.x + offset, y - bob);
        if (ko && !drawn) {
          const fall = Math.min(1, (clock - (p.koStart || clock - 400)) / 400);
          ctx.globalAlpha = .55;
          ctx.rotate(-p.direction * fall * Math.PI / 2);
        }
        if (anim?.kind === 'hit' && progress > 0 && progress < .6) ctx.filter = 'brightness(2.2) saturate(0.4)';
        else if (anim?.kind === 'attack' && !drawn && progress > 0) ctx.filter = 'brightness(1.35)';
        // Sources face right; mirror left walking.
        ctx.scale(p.direction / squash, squash);
        ctx.drawImage(sprite.image, frame.x, frame.y, frame.w, frame.h, -drawWidth / 2, -size, drawWidth, size);
      } else {
        if (ko) ctx.globalAlpha = .5;
        drawFallback(p, p.x + offset, y, now);
      }
      ctx.restore();
      drawEffects(p, p.x, y, clock);
      const health = healthOf(p, duel);
      if (health) drawHealthBar(p, p.x, y, health);
      ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = p.color;
      const rankedLabel = p.arenaProfile?.registered && Number.isFinite(Number(p.arenaProfile.elo))
        ? p.label + ' · ' + Math.round(Number(p.arenaProfile.elo))
        : p.label;
      ctx.strokeText(rankedLabel, p.x, y + 15); ctx.fillText(rankedLabel, p.x, y + 15);
      if (p.text && clock < p.bubbleUntil && !health) {
        const text = p.text.length > 38 ? p.text.slice(0, 37) + '…' : p.text;
        const bubbleWidth = Math.min(width, ctx.measureText(text).width + 16);
        const bx = Math.max(bubbleWidth / 2, Math.min(width - bubbleWidth / 2, p.x));
        ctx.fillStyle = 'rgba(18,18,26,.88)'; ctx.fillRect(bx - bubbleWidth / 2, y - size - 31, bubbleWidth, 23);
        ctx.fillStyle = '#ffffff'; ctx.fillText(text, bx, y - size - 15, Math.max(1, bubbleWidth - 8));
      }
    }
    drawParticles(clock, dt);
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
    }));
    arenaTransport = 'demo';
    arenaChat = { connected: true, lastSeen: Date.now(), status: 'enabled' };
    let revision = 1, round = 0, tick = 0, duel = null;
    const snapshot = () => acceptArenaSnapshot({ channel, revision: ++revision, paused: false, chat: { connected: true, lastSeen: Date.now(), status: 'enabled' }, config: { maxHp: 100 }, players: demoProfiles, duels: duel ? [duel] : [], events: [] }, { revision });
    const emit = fields => handleArenaEvent({ id: 'demo-' + revision + '-' + fields.type, at: Date.now(), ...fields });
    snapshot();
    const badge = document.createElement('div');
    badge.id = 'arena-mode';
    badge.textContent = 'DEMO · local match · not saved';
    Object.assign(badge.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2', padding: '7px 10px',
      borderRadius: '4px', color: '#fff', background: 'rgba(12,16,25,.82)',
      font: '600 11px system-ui,sans-serif', pointerEvents: 'none',
    });
    document.body.appendChild(badge);
    function beginRound() {
      round++; tick = 0;
      const a = 'demo-' + ((round * 2) % 8), b = 'demo-' + ((round * 2 + 1) % 8);
      for (const p of demoProfiles) p.respawnAt = 0;
      duel = { id: 'demo-duel-' + round, a, b, status: 'active', round, hp: { [a]: 100, [b]: 100 }, rules: { maxHp: 100 } };
      snapshot();
      emit({ type: 'duel_started', duelId: duel.id, a, b, round, hp: duel.hp });
    }
    beginRound();
    arenaTimer = setInterval(() => {
      if (!duel || duel.status !== 'active') { beginRound(); return; }
      tick++;
      const actor = tick % 2 ? duel.a : duel.b, target = actor === duel.a ? duel.b : duel.a;
      const ability = tick % 5 === 0 ? 'heal' : tick % 3 === 0 ? 'heavy' : 'strike';
      const amount = ability === 'heal' ? Math.min(15, 100 - duel.hp[actor]) : Math.min(duel.hp[target], ability === 'heavy' ? 25 : 18);
      duel.hp = { ...duel.hp, [ability === 'heal' ? actor : target]: duel.hp[ability === 'heal' ? actor : target] + (ability === 'heal' ? amount : -amount) };
      snapshot();
      emit({ type: 'duel_action', duelId: duel.id, userId: actor, targetId: ability === 'heal' ? actor : target, ability, amount, hp: duel.hp });
      if (duel.hp[target] <= 0) {
        const loser = demoProfiles.find(p => p.userId === target), winner = demoProfiles.find(p => p.userId === actor);
        loser.respawnAt = Date.now() + 2500;
        winner.elo += 12; loser.elo -= 12;
        duel = { ...duel, status: 'completed', winnerId: actor };
        snapshot();
        emit({ type: 'duel_completed', duelId: duel.id, winnerId: actor, loserId: target, round, respawnAt: loser.respawnAt, hp: duel.hp, ratings: { [actor]: { delta: 12 }, [target]: { delta: -12 } } });
      }
    }, 1300);
  }
  function startArena() {
    if (arenaDemo) { setupDemoArena(); return; }
    arenaClient = createArenaClient({
      channel,
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
    window.__arenaDebug = () => ({
      revision: arenaRevision,
      paused: arenaPaused,
      chat: arenaChat,
      profiles: profilesById.size,
      duels: arenaDuels,
      players: [...players.values()].map(p => ({ userId: p.userId, label: p.label, color: p.color, avatar: p.renderAvatar, elo: p.arenaProfile?.elo,
        x: Math.round(p.x), ko: p.koUntil > Date.now(), anim: p.anim && Date.now() < p.anim.until ? p.anim.kind : '' })),
      announcement: announcement && Date.now() < announcement.until ? announcement.text : '',
    });
  }
  updateStatus();
}
if (typeof document !== 'undefined') start().catch(error => {
  const status = document.querySelector('#status');
  if (status) { status.hidden = false; status.textContent = 'Overlay error: ' + error.message; }
});
