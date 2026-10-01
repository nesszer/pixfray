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
  let width = 1, height = 1, connectionState = demo ? 'demo' : 'connecting';
  let arenaSnapshot = null, arenaRelay = null, arenaTransport = arenaDemo ? 'demo' : 'connecting';
  let arenaRevision = null, arenaDuels = [], arenaClient = null, arenaTimer = null;
  let announcement = null;
  let lastFrame = performance.now(), lastCleanup = 0;
  function updateStatus(detail = '') {
    if (!status) return;
    const chatStatus = channel + ' · ' + connectionState + ' · ' + players.size + '/' + cap + ' characters';
    const relayOnline = arenaDemo || (arenaRelay?.connected === true && ['connected', 'live'].includes(arenaTransport));
    const relaySeenAt = typeof arenaRelay?.lastSeen === 'number'
      ? (arenaRelay.lastSeen < 1e12 ? arenaRelay.lastSeen * 1000 : arenaRelay.lastSeen)
      : Date.parse(arenaRelay?.lastSeen || '');
    const relayAge = Number.isFinite(relaySeenAt)
      ? Math.max(0, Math.floor((Date.now() - relaySeenAt) / 1000))
      : null;
    const relayAgeText = relayAge === null ? '' : relayAge < 60 ? ' · relay seen ' + relayAge + 's ago'
      : ' · relay seen ' + Math.floor(relayAge / 60) + 'm ago';
    const relayStatus = arenaEnabled
      ? ' · arena ' + (relayOnline ? 'relay live' : arenaTransport) +
        (arenaRelay?.connected && !relayOnline ? ' · stream ' + arenaTransport : '') +
        relayAgeText +
        (arenaRevision !== null ? ' r' + arenaRevision : '') +
        ' · ' + profilesById.size + ' profiles · ' + arenaDuels.length + ' duels'
      : '';
    if (debug) {
      status.textContent = chatStatus + relayStatus + (detail ? ' · ' + detail : '');
      status.hidden = false;
    } else if (arenaEnabled && !relayOnline) {
      status.textContent = arenaDemo ? 'DEMO arena · local only' : 'Arena offline · rankings paused';
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
  try {
    const entries = new Map();
    for (const item of await catalogItems('./assets/characters.json')) {
      if (typeof item?.id === 'string') entries.set(item.id.toLowerCase(), item);
    }
    if (arenaEnabled && !arenaDemo) {
      try {
        const remoteItems = await catalogItems('/api/catalog/' + encodeURIComponent(channel));
        for (const item of remoteItems) if (typeof item?.id === 'string') entries.set(item.id.toLowerCase(), item);
      } catch { /* A missing arena catalog leaves the bundled sprite set available. */ }
    }
    for (const [id, item] of entries) {
      if (!item || typeof item.url !== 'string') continue;
      const url = new URL(item.url, location.href);
      if (url.origin !== location.origin) continue;
      const frames = Array.isArray(item.frames) ? item.frames.filter(f =>
        [f.x, f.y, f.w, f.h].every(Number.isFinite) && f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0
      ) : [];
      const image = new Image();
      const sprite = { ...item, frames, image, loaded: false, fps: Math.max(1, Math.min(30, Number(item.fps) || 8)) };
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
  } catch { updateStatus('Using fallback characters'); }
  const ids = [...sprites.keys()];
  function persist() {
    // Bound storage so chat activity cannot grow an unlimited local profile file.
    const keys = Object.keys(settings);
    for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete settings[key];
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Storage is optional. */ }
  }
  function hop(p, amount) { p.vy = -amount; }
  function applyArenaProfile(p) {
    const profile = arenaEnabled && p.userId ? profilesById.get(String(p.userId)) : null;
    p.arenaProfile = profile || null;
    p.arenaEffect = p.userId ? recentArenaEffects.get(String(p.userId)) : null;
    if (!profile) {
      p.renderAvatar = p.avatar;
      return;
    }
    p.label = String(profile.displayName || profile.username || p.chatLabel || p.label).slice(0, 24);
    p.color = sanitizeColor(profile.color) || p.chatColor || p.color;
    p.renderAvatar = typeof profile.avatar === 'string' ? profile.avatar.toLowerCase() : p.avatar;
    p.defaultAbility = String(profile.defaultAbility || '').slice(0, 20);
  }
  function acceptArenaSnapshot(snapshot, metadata = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    arenaSnapshot = snapshot;
    arenaRelay = snapshot.relay && typeof snapshot.relay === 'object' ? snapshot.relay : null;
    arenaRevision = Number.isFinite(Number(metadata.revision))
      ? Number(metadata.revision)
      : Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : arenaRevision;
    const nextProfiles = new Map();
    for (const profile of Array.isArray(snapshot.players) ? snapshot.players : []) {
      if (profile?.userId !== undefined && profile?.userId !== null) nextProfiles.set(String(profile.userId), profile);
    }
    profilesById.clear();
    for (const [id, profile] of nextProfiles) profilesById.set(id, profile);
    arenaDuels = Array.isArray(snapshot.duels) ? snapshot.duels : [];
    if (arenaRelay?.connected === true) arenaTransport = 'live';
    for (const p of players.values()) applyArenaProfile(p);
    const completed = arenaDuels.find(duel => /complete|finished|resolved/i.test(String(duel?.status || '')));
    const winnerId = completed?.winnerId ?? completed?.winnerUserId ?? completed?.winner;
    if (winnerId !== undefined && winnerId !== null) {
      const winner = profilesById.get(String(typeof winnerId === 'object' ? winnerId.userId ?? winnerId.id : winnerId));
      if (winner) announceArena(String(winner.displayName || winner.username || 'Player') + ' wins', '#a7f3d0');
    }
    updateStatus();
  }
  function announceArena(text, color = '#fde68a') {
    if (text) announcement = { text: String(text).slice(0, 100), color, until: Date.now() + 5500 };
  }
  function eventUserId(value) {
    if (value && typeof value === 'object') return value.userId ?? value.id ?? value.playerId ?? null;
    return value === undefined || value === null ? null : value;
  }
  const recentArenaEffects = new Map();
  function handleArenaEvent(event) {
    if (!event || typeof event !== 'object') return;
    const type = String(event.type || event.kind || '').toLowerCase().replace(/[_. ]+/g, '-');
    const targetId = eventUserId(event.targetUserId ?? event.targetId ?? event.target ?? event.victimId ?? event.playerId ?? event.userId);
    const actorId = eventUserId(event.actorUserId ?? event.actorId ?? event.actor ?? event.attackerId ?? event.sourceUserId);
    if (/match|duel|result|finish|complete/.test(type) || event.winnerId !== undefined || event.winnerUserId !== undefined) {
      const winnerId = eventUserId(event.winnerId ?? event.winnerUserId ?? event.winner);
      const winner = winnerId === null ? null : profilesById.get(String(winnerId));
      const loserId = eventUserId(event.loserId ?? event.loserUserId ?? event.loser);
      const loser = loserId === null ? null : profilesById.get(String(loserId));
      if (winner) announceArena((winner.displayName || winner.username || 'Player') + ' wins' + (loser ? ' · ' + (loser.displayName || loser.username) : ''), '#a7f3d0');
    }
    const effect = /heal|restore/.test(type) ? 'heal'
      : /hit|damage|attack/.test(type) ? 'hit'
      : /ability|cast|skill/.test(type) ? 'ability'
      : '';
    const affectedId = effect === 'hit' || effect === 'heal' ? targetId : actorId ?? targetId;
    if (effect && affectedId !== null) {
      const id = String(affectedId);
      const now = Date.now();
      const amount = Number(event.damage ?? event.amount ?? event.heal ?? event.value);
      const label = effect === 'ability'
        ? String(event.ability || event.abilityName || profilesById.get(id)?.defaultAbility || 'Ability').slice(0, 20)
        : effect === 'heal' ? '+' + (Number.isFinite(amount) ? amount : '')
        : '-' + (Number.isFinite(amount) ? amount : '');
      const visual = { kind: effect, label, until: now + 1100, startedAt: now };
      recentArenaEffects.set(id, visual);
      for (const p of players.values()) if (String(p.userId) === id) p.arenaEffect = visual;
    }
    if (event.duel && typeof event.duel === 'object') {
      const id = String(event.duel.id ?? '');
      const index = arenaDuels.findIndex(duel => String(duel?.id ?? '') === id);
      if (index >= 0) arenaDuels[index] = event.duel;
      else arenaDuels = [...arenaDuels, event.duel];
    }
    updateStatus();
  }
  function arenaDuelFor(p) {
    if (!arenaEnabled || !p.userId) return null;
    const userId = String(p.userId);
    for (const duel of arenaDuels) {
      const a = eventUserId(duel?.a ?? duel?.aUserId ?? duel?.playerA);
      const b = eventUserId(duel?.b ?? duel?.bUserId ?? duel?.playerB);
      if (String(a) !== userId && String(b) !== userId) continue;
      const health = duel?.hp && typeof duel.hp === 'object' ? duel.hp[userId] : undefined;
      const current = Number(health?.hp ?? health);
      if (!Number.isFinite(current)) continue;
      const max = Number(duel?.config?.maxHp ?? duel?.config?.health ?? duel?.maxHp ?? 100);
      return { current: Math.max(0, current), max: Math.max(1, Number.isFinite(max) ? max : 100) };
    }
    const profileHp = Number(p.arenaProfile?.hp);
    return Number.isFinite(profileHp) ? { current: Math.max(0, profileHp), max: 100 } : null;
  }
  function onMessage(message) {
    const username = String(message.username || message.userId || '').toLowerCase().slice(0, 64);
    if (!username) return;
    const now = Date.now();
    let p = players.get(username);
    if (!p) {
      if (players.size >= cap) {
        const oldest = [...players.values()].reduce((a, b) => a.lastSeen < b.lastSeen ? a : b);
        players.delete(oldest.key);
      }
      const saved = settings[username] && typeof settings[username] === 'object' ? settings[username] : {};
      p = { key: username, userId: String(message.userId || ''), label: String(message.displayName || username).slice(0, 24),
        chatLabel: String(message.displayName || username).slice(0, 24),
        x: size / 2 + Math.random() * Math.max(0, width - size), speed: 14 + Math.random() * 20,
        direction: Math.random() < 0.5 ? -1 : 1, lane: Math.random() * 28, y: 0, vy: 0,
        avatar: sprites.has(saved.avatar) ? saved.avatar : ids[Math.floor(Math.random() * ids.length)],
        color: sanitizeColor(saved.color) || sanitizeColor(message.color) || '#a78bfa',
        chatColor: sanitizeColor(message.color), lastJump: 0, phase: Math.random() * 1000 };
      players.set(username, p);
    }
    if (message.userId !== undefined && message.userId !== null) p.userId = String(message.userId);
    if (message.displayName) p.chatLabel = String(message.displayName).slice(0, 24);
    if (sanitizeColor(message.color)) p.chatColor = sanitizeColor(message.color);
    if (!p.arenaProfile) {
      p.label = p.chatLabel || p.label;
      p.color = sanitizeColor(settings[username]?.color) || p.chatColor || p.color;
    }
    applyArenaProfile(p);
    p.lastSeen = now; p.messageId = message.id || ''; p.text = String(message.text || '').slice(0, 72); p.bubbleUntil = now + 4000;
    const command = parseCommand(message.text || '');
    if (command?.type === 'jump') {
      if (now - p.lastJump >= 3000) { hop(p, 300); p.lastJump = now; }
      p.text = ''; 
    } else if (command?.type === 'avatar') {
      if (!p.arenaProfile && sprites.has(command.value)) { p.avatar = command.value; settings[username] = { avatar: p.avatar, color: p.color }; persist(); }
      p.text = '';
    } else if (command?.type === 'color') {
      if (!p.arenaProfile) { p.color = command.value; settings[username] = { avatar: p.avatar, color: p.color }; persist(); }
      p.text = '';
    } else if (now - (p.lastReaction || 0) > 1500) { hop(p, 140); p.lastReaction = now; }
    updateStatus();
  }
  function onModeration(event) {
    if (event.type === 'clear') players.clear();
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
  function drawHealthBar(p, x, y) {
    const health = arenaDuelFor(p);
    if (!health) return;
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
    const elo = Number(p.arenaProfile?.elo);
    if (Number.isFinite(elo)) {
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,.9)';
      ctx.fillStyle = '#e2e8f0';
      ctx.strokeText(String(Math.round(elo)), x, top - 3);
      ctx.fillText(String(Math.round(elo)), x, top - 3);
    }
  }
  function drawArenaEffect(p, x, y, now) {
    const effect = p.arenaEffect;
    if (!effect || now >= effect.until) return;
    const remaining = Math.max(0, (effect.until - now) / 1100);
    const color = effect.kind === 'heal' ? '#4ade80' : effect.kind === 'hit' ? '#fb7185' : '#60a5fa';
    ctx.save();
    ctx.globalAlpha = remaining;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(x, y - size * .55, size * (.44 + (1 - remaining) * .2), 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.fillStyle = color;
    const lift = (1 - remaining) * 22;
    ctx.strokeText(effect.label, x, y - size - 30 - lift);
    ctx.fillText(effect.label, x, y - size - 30 - lift);
    ctx.restore();
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
  function draw(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
    const clock = Date.now();
    ctx.clearRect(0, 0, width, height);
    if (clock - lastCleanup > 1000) {
      for (const [key, p] of players) if (clock - p.lastSeen > 600000) players.delete(key);
      lastCleanup = clock; updateStatus();
    }
    for (const p of players.values()) {
      p.x += p.speed * p.direction * dt;
      const left = Math.min(size / 2, width / 2), right = Math.max(left, width - size / 2);
      if (p.x < left) { p.x = left; p.direction = 1; }
      if (p.x > right) { p.x = right; p.direction = -1; }
      p.vy += 750 * dt; p.y += p.vy * dt;
      if (p.y >= 0) { p.y = 0; p.vy = 0; }
      const y = height - 22 - p.lane + p.y;
      const sprite = sprites.get(p.renderAvatar || p.avatar);
      ctx.save();
      if (p.arenaEffect && clock < p.arenaEffect.until) {
        ctx.shadowColor = p.arenaEffect.kind === 'heal' ? '#4ade80' : p.arenaEffect.kind === 'hit' ? '#fb7185' : '#60a5fa';
        ctx.shadowBlur = 16;
      }
      if (sprite?.loaded) {
        const frame = sprite.frames[Math.floor((now + p.phase) / 1000 * sprite.fps) % sprite.frames.length];
        const drawWidth = size * frame.w / frame.h;
        ctx.translate(p.x, y);
        // Sources face right; mirror left walking.
        ctx.scale(p.direction, 1);
        ctx.drawImage(sprite.image, frame.x, frame.y, frame.w, frame.h, -drawWidth / 2, -size, drawWidth, size);
      } else drawFallback(p, p.x, y, now);
      ctx.restore();
      drawArenaEffect(p, p.x, y, clock);
      drawHealthBar(p, p.x, y);
      ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = p.color;
      const rankedLabel = p.arenaProfile && Number.isFinite(Number(p.arenaProfile.elo))
        ? p.label + ' · ' + Math.round(Number(p.arenaProfile.elo))
        : p.label;
      ctx.strokeText(rankedLabel, p.x, y + 15); ctx.fillText(rankedLabel, p.x, y + 15);
      if (p.defaultAbility) {
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = '#bfdbfe';
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(p.defaultAbility, p.x, y - size - 20);
        ctx.fillText(p.defaultAbility, p.x, y - size - 20);
      }
      if (p.text && clock < p.bubbleUntil) {
        const text = p.text.length > 38 ? p.text.slice(0, 37) + '…' : p.text;
        const bubbleWidth = Math.min(width, ctx.measureText(text).width + 16);
        const bx = Math.max(bubbleWidth / 2, Math.min(width - bubbleWidth / 2, p.x));
        ctx.fillStyle = 'rgba(18,18,26,.88)'; ctx.fillRect(bx - bubbleWidth / 2, y - size - 31, bubbleWidth, 23);
        ctx.fillStyle = '#ffffff'; ctx.fillText(text, bx, y - size - 15, Math.max(1, bubbleWidth - 8));
      }
    }
    drawAnnouncement();
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  function setupDemoArena() {
    const demoProfiles = [
      ['Ness', 'adventurer', '#fb923c', 'Spark', 1220],
      ['Sunny', 'female', '#60a5fa', 'Guard', 1184],
      ['Mochi', 'player', '#f472b6', 'Bloom', 1108],
      ['Cloud', 'soldier', '#a78bfa', 'Pulse', 1060],
      ['Pixel', 'zombie', '#4ade80', 'Echo', 1012],
      ['Bean', 'adventurer', '#facc15', 'Dash', 980],
      ['Luna', 'female', '#e879f9', 'Nova', 940],
      ['Sprout', 'player', '#34d399', 'Leaf', 900],
    ].map(([displayName, avatar, color, defaultAbility, elo], index) => ({
      userId: 'demo-' + index, username: displayName.toLowerCase(), displayName,
      avatar, color, defaultAbility, hp: 100, elo, wins: index % 4, losses: index % 3,
      lastSeen: new Date().toISOString(),
    }));
    arenaTransport = 'demo';
    arenaRelay = { connected: true, lastSeen: new Date().toISOString() };
    acceptArenaSnapshot({ channel, revision: 1, relay: arenaRelay, config: { maxHp: 100 }, players: demoProfiles, duels: [], events: [] }, { revision: 1 });
    const badge = document.createElement('div');
    badge.id = 'arena-mode';
    badge.textContent = 'DEMO · local match · not saved';
    Object.assign(badge.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2', padding: '7px 10px',
      borderRadius: '8px', color: '#fff', background: 'rgba(12,16,25,.82)',
      font: '600 11px system-ui,sans-serif', letterSpacing: '.04em', pointerEvents: 'none',
    });
    document.body.appendChild(badge);

    let round = 0, tick = 0, demoRevision = 1;
    function beginRound() {
      round++;
      tick = 0;
      const duel = { id: 'demo-duel-' + round, a: 'demo-0', b: 'demo-1', hp: { 'demo-0': 100, 'demo-1': 100 },
        status: 'active', config: { maxHp: 100, ability: 'defaultAbility' } };
      acceptArenaSnapshot({ channel, revision: ++demoRevision, relay: arenaRelay, config: { maxHp: 100 }, players: demoProfiles, duels: [duel], events: [] }, { revision: demoRevision });
    }
    beginRound();
    arenaTimer = setInterval(() => {
      const duel = arenaDuels[0];
      if (!duel || duel.status !== 'active') { beginRound(); return; }
      tick++;
      const target = tick % 2 ? 'demo-1' : 'demo-0';
      const actor = target === 'demo-1' ? 'demo-0' : 'demo-1';
      const amount = tick % 3 === 0 ? 28 : 36;
      const nextHp = { ...duel.hp, [target]: Math.max(0, Number(duel.hp[target]) - amount) };
      const winnerId = nextHp[target] === 0 ? actor : undefined;
      const nextDuel = { ...duel, hp: nextHp, status: winnerId ? 'complete' : 'active', ...(winnerId ? { winnerId } : {}) };
      const event = winnerId
        ? { id: 'demo-result-' + round, type: 'match_result', winnerId, loserId: target }
        : tick % 3 === 0
          ? { id: 'demo-ability-' + round + '-' + tick, type: 'ability', actorUserId: actor, ability: demoProfiles[Number(actor.slice(-1))].defaultAbility }
          : { id: 'demo-hit-' + round + '-' + tick, type: 'hit', actorUserId: actor, targetUserId: target, damage: amount };
      acceptArenaSnapshot({ channel, revision: ++demoRevision, relay: arenaRelay, config: { maxHp: 100 }, players: demoProfiles, duels: [nextDuel], events: [] }, { revision: demoRevision });
      handleArenaEvent(event);
    }, 1300);
  }
  function startArena() {
    if (!arenaEnabled) return;
    if (arenaDemo) {
      setupDemoArena();
      return;
    }
    arenaClient = createArenaClient({
      channel,
      onSnapshot: acceptArenaSnapshot,
      onEvent: handleArenaEvent,
      onStatus(event) {
        arenaTransport = event.state || 'offline';
        if (event.relay) arenaRelay = event.relay;
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
      profiles: profilesById.size,
      duels: arenaDuels,
      players: [...players.values()].map(p => ({ userId: p.userId, label: p.label, color: p.color, avatar: p.renderAvatar, elo: p.arenaProfile?.elo })),
      announcement: announcement?.text || '',
    });
  }
  updateStatus();
}
if (typeof document !== 'undefined') start().catch(error => {
  const status = document.querySelector('#status');
  if (status) { status.hidden = false; status.textContent = 'Overlay error: ' + error.message; }
});
