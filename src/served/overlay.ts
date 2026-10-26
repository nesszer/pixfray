// The OBS overlay entry (overlay.html loads overlay.js?v=): checks the channel is on, loads the characters, then starts
// drawing and the chat and arena connections. The modules beside it hold the pieces (docs/CONTRACTS.md section 8).
import {
  arena,
  arenaDemo,
  arenaEnabled,
  channel,
  configure,
  debug,
  demo,
  findPlayer,
  fxOn,
  meetPoints,
  players,
  profilesById,
  replayRatings,
  replays,
  resize,
  stage,
} from "./overlay-stage.ts";
import { addCatalog, ids, loadArenaCatalog, sprites } from "./overlay-sprites.ts";
import { banners, glows, push, sparks } from "./overlay-fx.ts";
import { liveAnnouncements, results } from "./overlay-duels.ts";
import { build, connect, ownVersion, updateStatus, watchBuild } from "./overlay-sync.ts";
import { nameColor, startDrawing } from "./overlay-draw.ts";

// The server's reason when the channel is off ('paused' | 'not_enabled'); '' (any other answer) lets the overlay run.
async function channelOff() {
  try {
    const r = await fetch(`/api/state/${channel}`, { headers: { Accept: "application/json" } });
    return r.status === 403 ? String((await r.json())?.off || "") : "";
  } catch {
    return "";
  }
}

// A channel that is off shows nothing and checks again every 5 minutes, so turning it back on needs no OBS refresh.
// One never set up (often a typo in the link) says so for a minute once per OBS session: seen in the preview, not on stream.
function showOff(off: string) {
  const status = document.querySelector("#status");
  let told = true;
  try {
    told = sessionStorage.getItem("pixfray:off-told") === channel;
    sessionStorage.setItem("pixfray:off-told", channel);
  } catch {
    told = false;
  }
  if (off === "not_enabled" && status && !told) {
    status.textContent = `PixFray isn't set up for "${channel}". Check the channel name in this OBS link, or set it up at ${location.host}/start`;
    setTimeout(() => {
      status.textContent = "";
    }, 60_000);
  }
  setTimeout(() => location.reload(), 300_000);
}

function exposeDebug() {
  window.__arenaMove = (userId, x) => {
    const p = findPlayer(String(userId));
    if (p) p.x = x;
  }; // tests: place fighters
  window.__arenaDebug = () => ({
    revision: arena.revision,
    paused: arena.paused,
    chat: arena.chat,
    profiles: profilesById.size,
    duels: arena.duels,
    replays: [...replays.values()],
    players: [...players.values()].map((p) => ({
      userId: p.userId,
      label: p.label,
      color: p.color,
      nameColor: nameColor(p.color),
      avatar: p.renderAvatar,
      elo: p.arenaProfile?.elo,
      shownElo: replayRatings(p.userId)?.before ?? p.arenaProfile?.elo,
      x: Math.round(p.x),
      ko: p.koUntil > Date.now(),
      anim: p.anim && Date.now() < p.anim.until ? p.anim.kind : "",
      grow: Math.round((p.grow || 1) * 100) / 100,
      shake: !!(p.shake && Date.now() < p.shake.until),
      die: p.die && Date.now() < p.die.until ? p.die.value : 0,
      float: p.floatText && Date.now() < p.floatText.until ? p.floatText.text : "",
      bubble: p.text && Date.now() < p.bubbleUntil ? p.text : "",
    })),
    announce: arena.announce,
    cap: arena.cap,
    build: build.first,
    staleBuild: build.stale,
    fx: fxOn ? "on" : "off",
    glows: glows.length,
    sparks: sparks.length,
    push: !!push,
    announcement: liveAnnouncements()
      .map((a) => a.text)
      .join(" | "),
    meets: [...meetPoints.values()].map((m) => Math.round(m.x)),
    gaps: [...meetPoints.values()].map((m) => Math.round(m.gap)),
    ownVersion,
    buildChanged: build.changed,
    banners: banners.filter((b) => Date.now() < b.until).map((b) => b.text),
    results: results.map((r) => ({ ...r })),
  });
}

async function start() {
  if (!stage) return;
  await configure();
  const off = demo ? "" : await channelOff();
  if (off) return showOff(off);
  addEventListener("resize", resize);
  resize();
  if (!(await addCatalog("./assets/characters.json"))) updateStatus("Using fallback characters");
  if (arenaEnabled && !arenaDemo) await loadArenaCatalog();
  // the id comes from sprites.keys()
  ids.push(...[...sprites.keys()].filter((id) => !sprites.get(id)!.custom));
  watchBuild();
  startDrawing();
  connect();
  if (debug && arenaEnabled) exposeDebug();
  updateStatus();
}
start().catch((error) => {
  const status = document.querySelector<HTMLElement>("#status");
  if (status) {
    status.hidden = false;
    status.textContent = `Overlay error: ${error.message}`;
  }
});
