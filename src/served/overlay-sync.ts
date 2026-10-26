// What the overlay hears: arena snapshots and saved looks from the server, chat messages, and new overlay code.
import { connectChat } from "./chat.ts";
import type { ChatMessage, ModerationEvent } from "./chat.ts";
import { createArenaClient } from "./arena-client.ts";
import {
  clipName,
  effectiveCap,
  overlayVersionFromHtml,
  overlayVersionFromUrl,
  parseCommand,
  sanitizeColor,
  truncateText,
} from "./text.ts";
import { COSMETIC_FIELDS, isObject, LOOK_STRINGS, parseLook, warnOnce } from "./parse.ts";
import type { ArenaProfile, ArenaSnapshot, LooksMessage } from "./parse.ts";
import {
  ANNOUNCE,
  arena,
  arenaDemo,
  arenaEnabled,
  bubblesOn,
  channel,
  debug,
  demo,
  droppedAt,
  dropPlayer,
  duelFor,
  findPlayer,
  inReplay,
  isFighter,
  meetPoints,
  openDuels,
  persist,
  players,
  profilesById,
  replays,
  settings,
  spawn,
  status,
  urlCap,
} from "./overlay-stage.ts";
import type { Player } from "./overlay-stage.ts";
import { lastCatalogFetch, loadArenaCatalog, missingAvatars, sprites } from "./overlay-sprites.ts";
import { queueArenaEvent } from "./overlay-duels.ts";
import { demoChat, setupDemoArena } from "./overlay-demo.ts";

export function updateStatus(detail = "") {
  if (!status) return;
  if (!debug) {
    // nothing on stream; the admin page shows whether chat is connected
    status.textContent = "";
    status.hidden = true;
    return;
  }
  const chatStatus = channel + " · " + arena.connection + " · " + players.size + "/" + arena.cap + " characters";
  const chatOnline = arenaDemo || (arena.chat?.connected === true && ["connected", "live"].includes(arena.transport));
  const chatAge =
    Number(arena.chat?.lastSeen) > 0
      ? // a lastSeen above 0 means arena.chat is set
        Math.max(0, Math.floor((Date.now() - Number(arena.chat!.lastSeen)) / 1000))
      : null;
  const arenaStatus = arenaEnabled
    ? " · arena " +
      (chatOnline ? "chat live" : arena.transport) +
      (chatAge === null
        ? ""
        : " · chat seen " + (chatAge < 60 ? chatAge + "s" : Math.floor(chatAge / 60) + "m") + " ago") +
      (arena.revision !== null ? " r" + arena.revision : "") +
      " · " +
      profilesById.size +
      " profiles · " +
      openDuels().length +
      " duels"
    : "";
  status.textContent = chatStatus + arenaStatus + (detail ? " · " + detail : "");
  status.hidden = false;
}

// Saved looks for chatters the arena doesn't list yet (a StreamElements channel only hears of a viewer when they
// use a command): login -> { at, look }, misses included. Registered profiles decide name, color and character;
// unregistered chatters keep their chat look. A saved look is cached 5 min and "no saved fighter" 1 min, since viewers
// often save mid-stream. Lookups are batched (20 logins every 2 s) so a few OBS sources on one connection stay under
// the edge rate limit (20 requests per 10 s per IP).
const savedLooks = new Map<string, { at: number; look: ArenaProfile | null }>(),
  lookQueue = new Set<string>();
let lookTimer: unknown = 0;
const LOOK_FIELDS = [...LOOK_STRINGS, "displayName", "elo"];
function lookOf(profile: ArenaProfile, username: string) {
  const look: ArenaProfile = { username, registered: true };
  for (const field of LOOK_FIELDS) if (profile[field] !== undefined) look[field] = profile[field];
  return look;
}
function queueLook(login: string) {
  const hit = savedLooks.get(login);
  if (!arenaEnabled || arenaDemo || (hit && Date.now() - hit.at < (hit.look ? 300_000 : 60_000))) return;
  lookQueue.add(login);
  if (!lookTimer) lookTimer = setTimeout(fetchLooks, 2000);
}
async function fetchLooks() {
  const batch = [...lookQueue].slice(0, 20);
  for (const login of batch) {
    lookQueue.delete(login);
    savedLooks.set(login, { at: Date.now(), look: savedLooks.get(login)?.look || null });
  }
  let retryMs = 2000;
  try {
    const response = await fetch("/api/looks/" + encodeURIComponent(channel) + "?u=" + batch.join(","), {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Looks HTTP " + response.status);
    const data: unknown = await response.json();
    for (const login of batch) {
      const entry = isObject(data) ? data[login] : null;
      const parsed = entry == null ? null : parseLook(entry);
      if (parsed && !parsed.ok) warnOnce("a saved look", parsed.error);
      const look = parsed?.value;
      savedLooks.set(login, { at: Date.now(), look: look ? { ...look, username: login, registered: true } : null });
    }
    for (const p of players.values()) if (batch.includes(p.key)) wearLook(p);
  } catch {
    // A failed lookup (a 429 from the rate limit blocks for 10 s) says nothing about the viewer: keep their current
    // look and ask again, rather than caching them as having no saved fighter.
    for (const login of batch) {
      savedLooks.get(login)!.at = 0; // every login in the batch was set above
      lookQueue.add(login);
    }
    retryMs = 10_000;
  }
  lookTimer = lookQueue.size ? setTimeout(fetchLooks, retryMs) : 0;
}
// A viewer whose saved fighter was deleted goes back to their chat name and color.
function wearLook(p: Player) {
  const had = p.arenaProfile?.registered;
  applyArenaProfile(p);
  if (had && !p.arenaProfile?.registered) {
    p.label = p.chatLabel || p.label;
    p.color = sanitizeColor(settings[p.key]?.color) || p.chatColor || p.color;
  }
}
// The server pushes {type:"looks"} when a saved fighter changes for a viewer it doesn't list (rank reset, removed
// sprite, deleted profile; null means deleted). reset: every cached look is stale. Viewers it lists come from snapshots.
function acceptLooks(message: LooksMessage) {
  const at = Date.now();
  if (message.reset) for (const hit of savedLooks.values()) hit.at = 0;
  const listed = new Set(
    [...profilesById.values()].filter((pr) => pr.registered).map((pr) => String(pr.username || "").toLowerCase()),
  );
  for (const [raw, look] of Object.entries(message.looks)) {
    const login = String(raw).toLowerCase().slice(0, 64);
    if (!login || listed.has(login)) continue;
    savedLooks.set(login, {
      at,
      look: look && typeof look === "object" ? { ...look, username: login, registered: true } : null,
    });
    const p = players.get(login);
    if (p) wearLook(p);
  }
  if (message.reset) refreshLooks();
}
// Safety net for a missed push or a dropped socket: once a minute, ask again for everyone on stage the server doesn't list.
function refreshLooks() {
  for (const p of players.values()) {
    if (profilesById.get(p.userId)?.registered) continue;
    const hit = savedLooks.get(p.key);
    if (hit) hit.at = 0;
    queueLook(p.key);
  }
}
function applyArenaProfile(p: Player) {
  const listed = arenaEnabled && p.userId ? profilesById.get(p.userId) : null;
  const profile = listed?.registered ? listed : (arenaEnabled && savedLooks.get(p.key)?.look) || listed || null;
  p.arenaProfile = profile || null;
  p.renderAvatar = p.avatar;
  p.defaultAbility = p.hat = p.pet = p.petTier = "";
  for (const field of COSMETIC_FIELDS) p[field] = "";
  if (!profile) return;
  if (profile.displayName || profile.username) p.label = clipName(profile.displayName || profile.username);
  if (!profile.registered) return;
  p.color = sanitizeColor(profile.color) || p.chatColor || p.color;
  const avatar = typeof profile.avatar === "string" ? profile.avatar.toLowerCase() : "";
  if (sprites.has(avatar)) p.renderAvatar = avatar;
  // A newly seen id (fresh upload) refetches at once; ids that stay unknown retry at most every 30 s.
  else if (
    avatar &&
    !arenaDemo &&
    (!missingAvatars.has(avatar) || Date.now() - lastCatalogFetch > 30_000) &&
    missingAvatars.add(avatar)
  )
    void loadArenaCatalog().then(() => {
      for (const q of players.values()) applyArenaProfile(q);
    });
  p.defaultAbility = String(profile.defaultAbility || "").slice(0, 20);
  for (const field of ["hat", "pet", "petTier"] as const)
    p[field] = typeof profile[field] === "string" ? profile[field] : "";
  // Cosmetics (cosmetics.ts): ids only; unknown ones draw nothing.
  for (const field of COSMETIC_FIELDS) p[field] = typeof profile[field] === "string" ? profile[field].slice(0, 32) : "";
}

// A new deploy changes the snapshot's build id. Most deploys leave the overlay's code alone, so the id only triggers a
// cheap check: the overlay page is fetched again and its ?v= code hash compared with the one this script was loaded with.
// Only changed overlay code reloads the page (between duels), so OBS never needs a manual refresh.
export const ownVersion = overlayVersionFromUrl(import.meta.url); // empty on the dev server, which never reloads
export const build = { first: "", last: "", stale: false, changed: false, checkAt: 0, checking: false };

export function acceptArenaSnapshot(snapshot: ArenaSnapshot, metadata: { revision?: number | null } = {}) {
  arena.chat = snapshot.chat || null;
  if (snapshot.config) arena.config = snapshot.config;
  if (ANNOUNCE.includes(arena.config.announce)) arena.announce = arena.config.announce;
  const wanted = effectiveCap(urlCap, arena.config.maxOnStream); // the lower of the link's ?cap= and the channel setting
  if (wanted !== arena.cap) {
    arena.cap = wanted;
    // A lower limit sends the longest-quiet chatters off first; fighters (open duel or replay) stay.
    const quiet = [...players.values()].filter((p) => !isFighter(p)).sort((a, b) => a.lastSeen - b.lastSeen);
    while (players.size > arena.cap && quiet.length) dropPlayer(quiet.shift()!); // the loop checks quiet.length
  }
  if (snapshot.build) {
    if (!build.first) build.first = build.last = snapshot.build;
    else if (snapshot.build !== build.last) {
      build.last = snapshot.build;
      if (ownVersion) build.changed = true;
    }
  }
  arena.paused = snapshot.paused === true;
  arena.revision = Number.isFinite(Number(metadata.revision))
    ? Number(metadata.revision)
    : Number.isFinite(Number(snapshot.revision))
      ? Number(snapshot.revision)
      : arena.revision;
  profilesById.clear();
  for (const profile of snapshot.players ?? [])
    if (profile.userId != null) profilesById.set(String(profile.userId), profile);
  // A registered profile in the snapshot is also the newest saved look for its login. The server drops a viewer from
  // its list after 10 quiet minutes and the overlay then falls back to the saved look, which must not be one fetched
  // before they changed their fighter on the website or played a duel.
  const lookAt = Date.now();
  for (const profile of profilesById.values()) {
    const login = String(profile.username || "")
      .toLowerCase()
      .slice(0, 64);
    if (profile.registered && login) savedLooks.set(login, { at: lookAt, look: lookOf(profile, login) });
  }
  arena.duels = snapshot.duels ?? [];
  if (arena.chat?.connected === true) arena.transport = "live";
  // Every overlay shows the same arena: the server's player list (fed by Twitch EventSub) spawns characters even
  // when this overlay's own chat connection is down, and players the server dropped leave the stage.
  for (const [key, p] of players) if (p.fromArena && !profilesById.has(p.userId)) players.delete(key);
  // The stage fills with the most recently active profiles while there is room. A snapshot never sends anyone off
  // (that happens when a new chatter joins, see spawn), so with more active players than the cap nothing churns.
  // The server's lastSeen is turned into "ms ago" relative to its newest profile, so it orders against local chat times.
  let newest = 0;
  for (const profile of profilesById.values()) newest = Math.max(newest, Number(profile.lastSeen) || 0);
  const activity = (profile: ArenaProfile) => Date.now() - Math.max(0, newest - (Number(profile.lastSeen) || 0));
  const candidates: { userId: string; profile: ArenaProfile; key: string; seen: number }[] = [];
  for (const [userId, profile] of profilesById) {
    const here = findPlayer(userId);
    if (here) {
      here.lastSeen = Math.max(here.lastSeen, activity(profile));
      continue;
    }
    const key = String(profile.username || "id:" + userId)
      .toLowerCase()
      .slice(0, 64);
    const existing = players.get(key);
    if (existing) {
      existing.userId = userId;
      continue;
    }
    const seen = Number(profile.lastSeen) || 0;
    // !: has() was checked first
    if (droppedAt.has(userId) && seen <= droppedAt.get(userId)!) continue; // sent off earlier and no more active since
    candidates.push({ userId, profile, key, seen });
  }
  candidates.sort((a, b) => b.seen - a.seen);
  for (const { userId, profile, key } of candidates) {
    if (players.size >= arena.cap) break;
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
  for (const id of meetPoints.keys())
    if (!replays.has(id) && !arena.duels.some((duel) => duel.id === id && duel.status === "active"))
      meetPoints.delete(id);
  updateStatus();
}
// The overlay page as the server serves it now: its script tag names the current code hash. At most one check
// every 30 s while the build id keeps changing (a rollout can serve two versions side by side); a failed fetch retries.
async function checkOverlayVersion() {
  build.checking = true;
  build.checkAt = Date.now();
  try {
    const response = await fetch(location.pathname + location.search, {
      cache: "no-store",
      headers: { accept: "text/html" },
    });
    if (!response.ok) throw new Error("Overlay page HTTP " + response.status);
    const latest = overlayVersionFromHtml(await response.text());
    build.changed = false;
    if (latest && latest !== ownVersion) build.stale = true;
  } catch {
    /* keep build.changed: the next tick asks again */
  }
  build.checking = false;
}
export function watchBuild() {
  setInterval(() => {
    if (build.changed && !build.checking && Date.now() - build.checkAt >= 30_000) void checkOverlayVersion();
    if (!build.stale || replays.size) return;
    // At most one reload a minute, in case a rollout serves two versions side by side.
    try {
      const last = Number(sessionStorage.getItem("mini-chat-reload")) || 0;
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem("mini-chat-reload", String(Date.now()));
    } catch {
      return;
    } // without storage there's no loop guard, so keep running the old code
    location.reload();
  }, 5000);
}

const CHAT_BOTS = new Set([
  "streamelements",
  "nightbot",
  "moobot",
  "fossabot",
  "streamlabs",
  "wizebot",
  "sery_bot",
  "soundalerts",
  "kofistreambot",
  "botrixoficial",
  "pixfray",
]); // same list as server/channel.ts
export function onMessage(message: { [K in keyof ChatMessage]?: ChatMessage[K] | undefined }) {
  const username = String(message.username || message.userId || "")
    .toLowerCase()
    .slice(0, 64);
  if (!username || CHAT_BOTS.has(username)) return;
  const now = Date.now();
  let p = players.get(username) || (message.userId ? findPlayer(message.userId) : null);
  if (!p) {
    // a real join: over the cap this sends the least recently active non-fighter off; no room if all are fighting
    const label = clipName(message.displayName || username);
    p = spawn(username, { label, chatLabel: label });
    if (p) droppedAt.delete(String(message.userId ?? ""));
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
  // A saved look older than 5 minutes is asked for again when its viewer chats, so a fighter changed on the website
  // reaches the stream even if the overlay missed the snapshot. Viewers the server lists come from its snapshots.
  if (!profilesById.get(p.userId)?.registered) queueLook(username);
  const ranked = Boolean(p.arenaProfile?.registered);
  p.lastSeen = now;
  p.messageId = message.id || "";
  p.text = bubblesOn ? truncateText(message.text || "", 72) : "";
  p.bubbleUntil = now + 4000;
  const command = parseCommand(message.text || "");
  if (command?.type === "jump") {
    if (now - p.lastJump >= 3000) {
      p.vy = -300;
      p.lastJump = now;
    }
    p.text = "";
  } else if (command) {
    // !avatar and !color: chat looks are kept in this browser, for unranked viewers only
    if (!ranked && (command.type === "color" || sprites.has(command.value))) {
      p[command.type] = command.value;
      settings[username] = { avatar: p.avatar, color: p.color };
      persist();
      if (command.type === "avatar") applyArenaProfile(p);
    }
    p.text = "";
  } else if (now - (p.lastReaction || 0) > 1500 && !duelFor(p)) {
    p.vy = -140;
    p.lastReaction = now;
  }
  updateStatus();
}
function onModeration(event: ModerationEvent) {
  if (event.type === "clear") {
    for (const [key, p] of players) if (!p.fromArena) players.delete(key);
  } else if (event.type === "delete") {
    for (const p of players.values())
      if (p.messageId === event.messageId) {
        p.text = "";
        p.bubbleUntil = 0;
      }
  } else {
    for (const [key, p] of players)
      if (
        (event.userId && p.userId === String(event.userId)) ||
        (event.username && key === String(event.username).toLowerCase())
      )
        players.delete(key);
  }
  updateStatus();
}

// Starts the arena feed (or the local demo duel) and this overlay's own chat connection.
export function connect() {
  const demoTimer = arenaDemo ? setupDemoArena() : undefined;
  const client =
    arenaEnabled && !arenaDemo
      ? createArenaClient({
          channel,
          role: "overlay",
          onSnapshot: acceptArenaSnapshot,
          onEvent: queueArenaEvent,
          onLooks: acceptLooks,
          // the new build id sits inside the frames this client can't read, so ask the page for its version instead
          onDrop() {
            if (ownVersion) build.changed = true;
          },
          onStatus(event) {
            arena.transport = event.state || "offline";
            if (event.chat) arena.chat = event.chat;
            updateStatus(event.message || "");
          },
        })
      : null;
  if (client) setInterval(refreshLooks, 60_000);
  const chat = demo
    ? demoChat()
    : connectChat(channel, {
        onMessage,
        onModeration,
        onStatus(event) {
          arena.connection = event.state;
          updateStatus(event.message || "");
        },
      });
  addEventListener(
    "pagehide",
    () => {
      chat.disconnect();
      client?.disconnect();
      clearInterval(demoTimer);
    },
    { once: true },
  );
}
