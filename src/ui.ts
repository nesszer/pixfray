// Shared helpers for the viewer dashboard and the admin page (Lane B). No framework.
// ?channel=<login> picks the channel; the configured default is used otherwise.
// Without it the viewer page asks which stream the viewer watches (CHANNEL_PICKED false); the admin page uses the default.
import site from "../site.config.js";
import { channelParam } from "./channel-param.ts";
// The pages' HTML names the default channel (%SITE_CHANNEL%, vite.config.ts); applyChannel swaps it for the current one.
const TEMPLATE_CHANNEL = site.defaultChannel;
const raw = new URLSearchParams(location.search).get("channel");
const asked = channelParam(raw);
export const CHANNEL_PICKED = asked !== "";
// A link that carried trailing punctuation from chat: show the clean address, so sharing or signing in keeps it.
if (CHANNEL_PICKED && raw !== asked) {
  const u = new URL(location.href);
  u.searchParams.set("channel", asked);
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}
export const CHANNEL = CHANNEL_PICKED ? asked : site.defaultChannel;
// A same-site link that keeps the current channel. Links always name it, since the viewer page without one is the /play/ picker.
export const withChannel = (path: string) => path + (path.includes("?") ? "&" : "?") + "channel=" + CHANNEL;
// This page's address without the one-time flags sign-in adds: where signing in or out comes back to.
export function here() {
  const u = new URL(location.href);
  for (const k of ["signed_in", "mods", "bot"]) u.searchParams.delete(k);
  return u.pathname + u.search + u.hash;
}
// Twitch sign-in that comes back to this page, its channel and its tab.
export const loginHref = (next: string = here()) =>
  "/auth/login?" + new URLSearchParams({ ...(CHANNEL_PICKED ? { channel: CHANNEL } : {}), next });
// Sign-in links (data-login) take the tab that is open when they're clicked, not the one open when they were drawn.
document.addEventListener(
  "click",
  (e) => {
    // the target of a click is an element; closest?. still skips anything else
    const a = (e.target as Element).closest?.<HTMLAnchorElement>("a[data-login]");
    if (a) a.href = loginHref();
  },
  true,
);
// Phones scroll the header links sideways; the current page's link starts in view.
{
  const nav = document.querySelector(".topbar nav"),
    cur = nav?.querySelector("[aria-current]");
  // nav!: cur was found inside nav, so nav is set whenever cur is
  if (cur && nav!.scrollWidth > nav!.clientWidth)
    nav!.scrollLeft = Math.max(0, cur.getBoundingClientRect().right - nav!.getBoundingClientRect().right + 28); // nav!: as above
}
// Put the channel name into the page: elements marked data-channel get the template token replaced, and links in nav keep the channel.
export function applyChannel() {
  for (const a of document.querySelectorAll("a[data-keep-channel]"))
    a.setAttribute("href", withChannel(a.getAttribute("href") as string)); // the page HTML gives each of these links an href
  for (const a of document.querySelectorAll("a[data-login]")) a.setAttribute("href", loginHref());
  if (CHANNEL === TEMPLATE_CHANNEL) return;
  document.title = document.title.replaceAll(TEMPLATE_CHANNEL, CHANNEL);
  for (const el of document.querySelectorAll("[data-channel]")) {
    // casts: the tag name was just checked, and an element's textContent is never null
    if (el.tagName === "INPUT") (el as HTMLInputElement).value = CHANNEL;
    else if (el.tagName === "META")
      (el as HTMLMetaElement).content = (el as HTMLMetaElement).content.replaceAll(TEMPLATE_CHANNEL, CHANNEL); // the tag name was just checked
    else el.textContent = (el.textContent as string).replaceAll(TEMPLATE_CHANNEL, CHANNEL); // an element's textContent is never null
  }
}
export const DEFAULT_COLOR = "#a78bfa";
export const DEFAULT_ABILITIES = {
  strike: { damage: 20, cooldownMs: 2000 },
  heavy: { damage: 35, cooldownMs: 5000 },
  heal: { amount: 15, cooldownMs: 12000 },
};
export const ABILITY_NAMES = { strike: "Strike", heavy: "Heavy strike", heal: "Heal" };

// JSON fetch that never throws: {ok, status, data}. Same-origin, so POSTs carry the Origin header the Worker requires.
export async function api(
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
  // data is any: the parsed JSON body, which callers that are still .js read per route (typed per route in TS20)
): Promise<{ ok: boolean; status: number; data: any }> {
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  // reads retry twice when rate-limited, waiting as asked (at most 4 s)
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(path, init);
    } catch {
      return { ok: false, status: 0, data: { error: "Network error. Check your connection and try again." } };
    }
    if (response.status !== 429 || method !== "GET" || attempt === 2) break;
    const wait = Math.min(4, Number(response.headers.get("Retry-After")) || attempt + 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { ok: response.ok, status: response.status, data };
}
// r.data is any: api()'s parsed body, untyped until TS20
export const errorText = (r: { status: number; data: any }, fallback = "Request failed") =>
  (r.data && (r.data.error || r.data.reason)) ||
  (r.status === 429
    ? "Too many requests right now. Try again in a minute"
    : r.status >= 500
      ? "The server had a problem. Try again in a minute"
      : r.status
        ? fallback + " (HTTP " + r.status + ")"
        : fallback);

// Tiny DOM builder. Strings become text nodes, so user-supplied names are never parsed as HTML.
// Returns the element type of the tag, so callers can set its own properties (input.value, img.src).
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = {},
  ...children: unknown[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value as string; // callers pass the class list as a string
    else if (key === "style" && typeof value === "object")
      for (const [p, v] of Object.entries(value)) node.style.setProperty(p, v as string); // style values are strings
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value as EventListener); // on* attrs are event handlers
    else if (key in node && typeof value !== "string") (node as unknown as Record<string, unknown>)[key] = value; // key in node: a property this element has (own or inherited, like value or checked)
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity))
    if (child !== null && child !== undefined && child !== false)
      node.append(child instanceof Node ? child : String(child));
  return node;
}
// The element at selector, typed as the caller's page HTML holds it (T includes null where it may be missing).
export const $ = <T extends Element | null = HTMLElement>(selector: string, root: ParentNode = document) =>
  root.querySelector(selector) as T; // as T: the caller names the element type, as above
export function setStatus(node: Element, message: string | null | undefined, kind = "") {
  node.textContent = message || "";
  node.className = "status" + (kind ? " " + kind : "");
}

export const seconds = (ms: number) => {
  const s = ms / 1000;
  return (Number.isInteger(s) ? s : s.toFixed(2).replace(/0+$/, "")) + " s";
};
export function abilityDetail(name: string, spec: { damage?: number; amount?: number; cooldownMs?: number } = {}) {
  const cd = Number.isInteger(spec.cooldownMs) ? seconds(spec.cooldownMs) + " cooldown" : "";
  if (name === "heal") return (spec.amount ?? "?") + " HP heal, " + cd;
  return (spec.damage ?? "?") + " damage, " + cd;
}
export function timeAgo(ms: number | null | undefined) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + " s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ms).toLocaleDateString();
}
export const dateTime = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
export const formatBytes = (n: number) =>
  n >= 1048576 ? (n / 1048576).toFixed(2) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";

// Fills the signed-in area of the top bar on both pages.
export function renderWho(
  container: Element,
  session: { user?: { login: string; displayName?: string } | null; configured?: boolean } | null | undefined,
  onSignOut: () => void,
) {
  container.replaceChildren();
  if (session?.user) {
    container.append(
      h("span", {}, "Signed in as ", h("strong", {}, session.user.displayName || session.user.login)),
      h("button", { class: "btn btn-small", type: "button", onclick: onSignOut }, "Sign out"),
    );
  } else if (session && session.configured === false) {
    container.append(h("span", {}, "Twitch sign-in isn't set up on this server yet"));
  } else {
    container.append(h("a", { class: "btn", href: loginHref(), "data-login": "" }, "Sign in with Twitch"));
  }
}
// Signing out stays on this page and channel (minus the sign-in flags).
export async function signOut() {
  await api("/auth/logout", { method: "POST" });
  const to = here();
  if (to === location.pathname + location.search + location.hash) location.reload();
  else location.replace(to);
}

// ---------- sprite previews ----------
// One requestAnimationFrame loop drives every animated canvas. Thumbnails stay on a still frame and animate only
// while hovered, focused or selected; the main preview loops the walk cycle. prefers-reduced-motion keeps all still.
/** A frame's rectangle in a character sheet. */
type Frame = { x: number; y: number; w: number; h: number };
/** A catalog character as the API sends it (the fields drawn here). */
type Entry = {
  id: string;
  url: string;
  frames?: Frame[];
  animations?: Record<string, Frame[] | undefined>;
  fps?: number;
  head?: unknown;
};
/** A pet: { id, tier, url? }; uploaded pets have a url to their PNG. */
type Pet = { id?: string; tier?: unknown; url?: string };
/** cosmetics.js ids. */
type Looks = {
  recolor?: string;
  accessory?: string;
  petColor?: string;
  trail?: string;
  winEffect?: string;
  title?: string;
  taunt?: string;
};
type Sprite = {
  canvas: HTMLCanvasElement;
  entry: Entry | null | undefined;
  anim: string;
  active: () => boolean;
  hat: string;
  pet: Pet | null;
  looks: Looks;
  looksKey: string;
  drawn: string;
};
const images = new Map<string, HTMLImageElement>();
const sprites = new Set<Sprite>();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const redraws = new Map<() => void, Element>(); // stills and stages that redraw once a module or image arrives: draw -> its canvas
const redrawAll = () => {
  for (const s of sprites) s.drawn = "";
  start();
  for (const d of redraws.keys()) d();
};
// Lists rebuild their canvases on every render; the old ones are dropped a moment later, once the new list is in
// the page (a canvas is added here before it is attached).
let sweep: ReturnType<typeof setTimeout> = 0; // a number in the browser, so 0 means none
// Calls draw whenever a drawing module (hats, pets, cosmetics) or a watched image arrives.
export function onLooksReady(canvas: Element, draw: () => void) {
  redraws.set(draw, canvas);
  if (!sweep)
    sweep = setTimeout(() => {
      sweep = 0;
      for (const [d, c] of redraws) if (!c.isConnected) redraws.delete(d);
    }, 1000);
}
reducedMotion.addEventListener("change", redrawAll);
function image(url: string) {
  if (!images.has(url)) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    images.set(url, img);
  }
  return images.get(url)!; // set just above when it was missing
}
export const framesFor = (entry: Entry | null | undefined, anim: string) => {
  const a: Record<string, Frame[] | undefined> = entry?.animations || {};
  const list =
    anim === "idle"
      ? a.idle || entry?.frames
      : anim === "walk"
        ? a.walk || entry?.frames
        : a[anim] || a.idle || entry?.frames;
  return Array.isArray(list) && list.length ? list : [];
};
// Hats are drawn by src/served/hats.ts, the same module the overlay uses. It is served as /hats.js (vite.config.ts),
// not bundled, so it loads at runtime.
// Pets (src/served/pets.ts) and cosmetics (recolors, accessories, trails, win effects, taunts, titles;
// src/served/cosmetics.ts) load the same way, as on stream.
// any: these modules load at runtime from their URLs, so no types reach here
let hats: any = null,
  pets: any = null,
  cosmetics: any = null;
// a full URL, so Vite leaves the import alone; m is any for the reason above
const served = (name: string, keep: (m: any) => void) =>
  import(/* @vite-ignore */ new URL("/" + name + ".js", location.href).href).then(
    (m) => {
      keep(m);
      redrawAll();
      return m;
    },
    () => null,
  );
served("hats", (m) => (hats = m));
served("pets", (m) => (pets = m));
export const cosmeticsReady = served("cosmetics", (m) => (cosmetics = m));
const tint = (id: string | undefined) => cosmetics?.recolorFilter(id) || "none";
const petArg = (pet: Pet | null | undefined) => (pet?.url ? { image: image(pet.url) } : pet?.id || "");
// A still pet on its own canvas (the dashboard's pet list), in a pet color (cosmetics.js) if one is given.
export function addPet(
  canvas: HTMLCanvasElement,
  pet: Pet | null | undefined,
  { color = "" }: { color?: string } = {},
) {
  const draw = () => {
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D; // a canvas only drawn in 2D always has one
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!pets || !pet?.id) return;
    pets.drawPet(ctx, petArg(pet), canvas.width / 2, canvas.height - 2, canvas.height * 0.62, {
      tier: pet.tier,
      still: true,
      tint: tint(color),
    });
  };
  onLooksReady(canvas, draw);
  if (pet?.url) image(pet.url).addEventListener("load", draw, { once: true });
  draw();
}
// A still sample of a trail or a win effect for the shop lists.
export function addCosmeticSample(canvas: HTMLCanvasElement, kind: string, id: string) {
  const draw = () => {
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D, // a canvas only drawn in 2D always has one
      w = canvas.width,
      hgt = canvas.height;
    ctx.clearRect(0, 0, w, hgt);
    if (!cosmetics || !id) return;
    if (kind === "trail") cosmetics.drawTrailSample(ctx, id, w * 0.78, hgt * 0.78, hgt * 0.9);
    else if (kind === "effect")
      cosmetics.drawWinEffect(
        ctx,
        id,
        w / 2,
        hgt * 1.25,
        hgt * 0.42,
        id === "fireworks" ? 0.42 : id === "banner" ? 0.5 : 0.12,
        7,
      );
  };
  onLooksReady(canvas, draw);
  draw();
}
// looks: { recolor, accessory, petColor } (cosmetics.js ids), drawn as on stream.
export function drawFrame(
  canvas: HTMLCanvasElement,
  entry: Entry,
  frame: Frame | undefined,
  hat = "",
  pet: Pet | null = null,
  t = 0,
  looks: Looks = {},
) {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D; // a canvas only drawn in 2D always has one
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const img = entry && image(entry.url);
  if (!frame || !img.complete || !img.naturalWidth) return false;
  const scale = Math.min(canvas.width / frame.w, canvas.height / frame.h);
  const w = Math.round(frame.w * scale),
    h2 = Math.round(frame.h * scale);
  ctx.imageSmoothingEnabled = false;
  // With a hat, the figure is shrunk a little so the hat stays inside the canvas.
  const room = (hat && hats) || (looks.accessory && cosmetics) ? 0.8 : 1;
  const dw = Math.round(w * room),
    dh = Math.round(h2 * room),
    dx = Math.round((canvas.width - dw) / 2),
    dy = canvas.height - dh;
  // A pet stands behind the fighter, on its left, like on stream.
  if (pet?.id && pets) {
    pets.drawPet(ctx, petArg(pet), canvas.width * 0.2, canvas.height - 1, canvas.height * 0.3, {
      tier: pet.tier,
      t,
      moving: t > 0,
      still: !t,
      tint: tint(looks.petColor),
    });
  }
  drawFighter(ctx, entry, img, frame, [dx, dy, dw, dh], hat, looks, t, t > 0);
  return true;
}
// The fighter in box [x, y, w, h]: accessory back layer, the recolored body, the hat, then the accessory's front.
function drawFighter(
  ctx: CanvasRenderingContext2D,
  entry: Entry,
  img: HTMLImageElement,
  frame: Frame,
  box: [number, number, number, number],
  hat: string,
  looks: Looks,
  t: number,
  moving: boolean,
) {
  const look = { headHint: entry.head, t, moving };
  if (looks.accessory && cosmetics)
    cosmetics.drawAccessory(ctx, looks.accessory, img, frame, ...box, { ...look, layer: "back" });
  ctx.save();
  ctx.filter = tint(looks.recolor); // the recolor tints the body only
  ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, ...box);
  ctx.restore();
  if (hat && hats) hats.drawHat(ctx, hat, img, frame, ...box, entry.head);
  if (looks.accessory && cosmetics) cosmetics.drawAccessory(ctx, looks.accessory, img, frame, ...box, look);
}
// sprite = {canvas, entry, anim, active()} ; returns a handle with .set(entry) and .destroy()
export function addSprite(
  canvas: HTMLCanvasElement,
  entry: Entry | null | undefined,
  {
    anim = "walk",
    active = () => true,
    hat = "",
    pet = null,
    looks = {},
  }: { anim?: string; active?: () => boolean; hat?: string; pet?: Pet | null; looks?: Looks } = {},
) {
  const s: Sprite = { canvas, entry, anim, active, hat, pet, looks, looksKey: JSON.stringify(looks), drawn: "" };
  sprites.add(s);
  // redraws now, and again once the picture at url has loaded
  const redraw = (url?: string) => {
    s.drawn = "";
    if (url) image(url).addEventListener("load", () => redraw(), { once: true });
    start();
  };
  redraw(entry?.url);
  return {
    hat(id: string | null | undefined) {
      s.hat = id || "";
      redraw();
    },
    looks(next: Looks | null | undefined) {
      s.looks = next || {};
      s.looksKey = JSON.stringify(s.looks);
      redraw();
    },
    pet(next: Pet | null | undefined) {
      s.pet = next?.id ? next : null;
      redraw(next?.url);
    },
    set(next: Entry | null | undefined) {
      s.entry = next;
      redraw(next?.url);
    },
    destroy() {
      sprites.delete(s);
    },
  };
}
let running = false;
function start() {
  if (!running) {
    running = true;
    requestAnimationFrame(tick);
  }
}
// Walking sprites and the on-stream stage come to rest REST_MS after the last input, and stop drawing; any input wakes them.
const REST_MS = 10000,
  stages = new Set<() => void>();
let lastInput = performance.now();
const awake = () => performance.now() - lastInput < REST_MS;
const INPUTS = [
  "pointermove",
  "pointerover",
  "pointerdown",
  "keydown",
  "focusin",
  "change",
  "scroll",
  "visibilitychange",
];
for (const ev of INPUTS)
  addEventListener(
    ev,
    () => {
      lastInput = performance.now();
      if (sprites.size) start();
      stages.forEach((kick) => kick());
    },
    { passive: true, capture: true },
  );
function tick(now: number) {
  let busy = false;
  for (const s of sprites) {
    if (!s.canvas.isConnected) {
      sprites.delete(s);
      continue;
    }
    const moving = !reducedMotion.matches && s.active() && awake();
    const frames = framesFor(s.entry, moving ? s.anim : "idle");
    const index = moving && frames.length ? Math.floor(now / (1000 / (s.entry?.fps || 8))) % frames.length : 0;
    // A pet animates on its own clock (hop, hover, wings), so a moving sprite with a pet redraws every frame.
    const petT = s.pet && moving ? Math.round(now) : 0;
    const key = [s.entry?.id, moving ? s.anim : "idle", index, s.hat, s.pet?.id, petT, s.looksKey].join(":");
    // s.entry as Entry: without an entry there are no frames, and drawFrame returns before reading it
    if (key !== s.drawn && drawFrame(s.canvas, s.entry as Entry, frames[index], s.hat, s.pet, petT, s.looks))
      s.drawn = key;
    if (moving || key !== s.drawn) busy = true;
  }
  // With reduced motion every sprite is a still frame, so the loop sleeps until something needs redrawing.
  if (busy && !reducedMotion.matches && !document.hidden) requestAnimationFrame(tick);
  else running = false;
}

// ---------- the 3D preview's source pictures ----------
// The look as flat pictures for src/fighter3d.ts to rebuild as voxels: the idle frame with its hat, recolor and
// accessory, and the pet on its own canvas. frameH is the sprite's drawn height in pixels, so every character keeps
// its size relative to the frame, as on stream. Returns null until the character image has loaded.
export function composeLook(
  entry: Entry | null | undefined,
  { hat = "", pet = null, looks = {} }: { hat?: string; pet?: Pet | null; looks?: Looks } = {},
) {
  const frame = framesFor(entry, "idle")[0],
    // as: img is null only without an entry, and then there is no frame and the check below returns first
    img = (entry && image(entry.url)) as HTMLImageElement;
  if (!frame || !img.complete || !img.naturalWidth) return null;
  const body = document.createElement("canvas");
  body.width = frame.w;
  body.height = frame.h;
  if (!drawFrame(body, entry!, frame, hat, null, 0, looks)) return null; // entry!: there is a frame, so there is an entry
  const room = (hat && hats) || (looks.accessory && cosmetics) ? 0.8 : 1;
  const out: { body: HTMLCanvasElement; frameH: number; pet: HTMLCanvasElement | null; petH: number; key: string } = {
    body,
    frameH: frame.h * room,
    pet: null,
    petH: 64,
    key: [
      entry!.id, // entry!: there is a frame, so there is an entry
      hat,
      looks.recolor,
      looks.accessory,
      pet?.id,
      pet?.tier,
      looks.petColor,
      Boolean(hats),
      Boolean(cosmetics),
      Boolean(pets),
    ].join(":"),
  };
  if (pet?.id && pets) {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 128;
    pets.drawPet(c.getContext("2d"), petArg(pet), 80, 126, out.petH, {
      tier: pet.tier,
      still: true,
      tint: tint(looks.petColor),
    });
    out.pet = c;
  }
  return out;
}
export function whenImage(url: string, fn: () => void) {
  const img = image(url);
  if (img.complete && img.naturalWidth) return;
  img.addEventListener("load", fn, { once: true });
}

// ---------- the on-stream preview ----------
// The viewer page's stage: the fighter walking in place as the overlay draws it (src/served/overlay.ts), with its
// pet, trail, recolor, hat, accessory, the nameplate "name · Elo" and title, and on play() its win effect and taunt.
// Sizes follow the overlay's 60 px fighter, 20 px nameplate and 14 px title, scaled to the canvas height.
// set({ entry, hat, pet, color, name, elo, looks }) changes what it shows; looks holds the cosmetics.js ids.
const fits = new Map<string, number>();
function fitOf(entry: Entry, img: HTMLImageElement, frame: Frame) {
  // the overlay's bulkFit: big, square sprites are drawn a little smaller
  if (fits.has(entry.id)) return fits.get(entry.id)!; // has() just found it
  let fit = 1;
  try {
    const c = document.createElement("canvas");
    c.width = frame.w;
    c.height = frame.h;
    const g = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D; // a new canvas always has a 2D context
    g.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    const data = g.getImageData(0, 0, frame.w, frame.h).data;
    let left = frame.w,
      right = -1,
      top = frame.h,
      bottom = -1;
    for (let y = 0; y < frame.h; y++)
      for (let x = 0; x < frame.w; x++) {
        if (data[(y * frame.w + x) * 4 + 3]! <= 40) continue; // in range: x and y stay inside the frame's pixels
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    if (right >= left) fit = Math.min(1, 0.78 / (Math.sqrt((right - left + 1) * (bottom - top + 1)) / frame.h));
  } catch {}
  fits.set(entry.id, fit);
  return fit;
}
type Stage = {
  entry: Entry | null;
  hat: string;
  pet: Pet | null;
  color: string;
  name: string;
  elo: number | null;
  looks: Looks;
  win: { start: number; seed: number } | null;
};
export function addStage(canvas: HTMLCanvasElement) {
  const st: Stage = {
    entry: null,
    hat: "",
    pet: null,
    color: DEFAULT_COLOR,
    name: "you",
    elo: null,
    looks: {},
    win: null,
  };
  let trail: any = null, // a cosmetics.js trail; that module loads at runtime, untyped
    trailId = "",
    raf = 0,
    shown = true;
  const kick = () => {
    if (!raf && shown) raf = requestAnimationFrame(loop);
  };
  // off screen or hidden by the layout (phones), the stage stops drawing until it shows again
  new IntersectionObserver(([en]) => {
    shown = en!.isIntersecting; // an observer callback always gets at least one entry
    kick();
  }).observe(canvas);
  stages.add(kick);
  function loop(now: number) {
    raf = 0;
    if (!canvas.isConnected || document.hidden) return;
    draw(now);
    const playing = st.win && now - st.win.start < 4500;
    if ((!reducedMotion.matches && awake()) || playing) kick();
  }
  function draw(now: number) {
    const dpr = Math.min(2, devicePixelRatio || 1),
      cw = canvas.clientWidth,
      ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const W = canvas.width,
      H = canvas.height,
      ctx = canvas.getContext("2d") as CanvasRenderingContext2D; // a canvas only drawn in 2D always has one
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const still = reducedMotion.matches || !awake(),
      k = Math.max(H / 170, 0.8 * dpr),
      s = 60 * k,
      ground = Math.round(H - 46 * k),
      x = Math.round(W * 0.56);
    const win = st.win && now - st.win.start < 4500 ? st.win : null,
      effectOn = win && now - win.start < (cosmetics?.WIN_EFFECT_MS || 3000);
    const moving = !still && !effectOn,
      L = st.looks || {};
    // The floor, with marks that slide back while the fighter walks in place.
    ctx.fillStyle = "rgba(201,164,92,.35)";
    ctx.fillRect(0, ground + Math.round(2 * k), W, Math.max(1, Math.round(k)));
    const gap = 46 * k,
      slide = moving ? ((now / 1000) * s * 1.4) % gap : 0;
    for (let mx = -slide; mx < W; mx += gap)
      ctx.fillRect(Math.round(mx), ground + Math.round(5 * k), Math.round(10 * k), Math.max(1, Math.round(k)));
    ctx.imageSmoothingEnabled = false;
    // Trail particles drift backwards, as if left behind on the walk; a still page shows a sample instead.
    if (trailId !== (L.trail || "")) {
      trailId = L.trail || "";
      trail?.clear();
    }
    if (cosmetics && trailId) {
      trail ||= cosmetics.createTrail(160);
      if (moving) trail.spawn("me", trailId, x, ground, s, 1, now, -s * 1.4);
      trail.draw(ctx, now);
      if (still) cosmetics.drawTrailSample(ctx, trailId, x - s * 0.35, ground - s * 0.05, s);
    }
    if (st.pet?.id && pets) {
      pets.drawPet(ctx, petArg(st.pet), x - s * 0.55, ground, s * 0.42, {
        facing: 1,
        t: still ? 0 : now,
        moving,
        tier: st.pet.tier,
        still,
        tint: tint(L.petColor),
      });
    }
    // as: img is null only without an entry, and then there are no frames and it is never read
    const img = (st.entry && image(st.entry.url)) as HTMLImageElement;
    const frames = framesFor(st.entry, moving ? "walk" : effectOn ? "cheer" : "idle");
    // st.entry!, frames[0]!: without an entry there are no frames, so with a frame both are set
    const frame = frames.length
      ? frames[still ? 0 : Math.floor(now / (1000 / (st.entry!.fps || 8))) % frames.length] // st.entry!: as above
      : null;
    if (frame && img.complete && img.naturalWidth) {
      const dh = s * fitOf(st.entry!, img, frames[0]!), // st.entry!, frames[0]!: as above
        dw = (dh * frame.w) / frame.h;
      // st.entry!: as above
      drawFighter(ctx, st.entry!, img, frame, [x - dw / 2, ground - dh, dw, dh], st.hat, L, now, moving);
    }
    // The win effect, shrunk if the stage is too short for it; a still page shows one frame of it.
    if (effectOn && L.winEffect && cosmetics) {
      const size = Math.min(s, (ground - 4 * k) / 2.85);
      cosmetics.drawWinEffect(
        ctx,
        L.winEffect,
        x,
        ground,
        size,
        still ? 0.45 : (now - win.start) / cosmetics.WIN_EFFECT_MS,
        win.seed,
      );
    }
    // Nameplate and title, as on stream.
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,.85)";
    ctx.font = "bold " + Math.round(20 * k) + "px system-ui, sans-serif";
    ctx.lineWidth = 4 * k;
    const label = st.name + (Number.isFinite(st.elo) ? " · " + st.elo : ""),
      lw = ctx.measureText(label).width;
    const fit = W - 8 * k,
      half = Math.min(lw, fit) / 2,
      lx = Math.max(half + 4 * k, Math.min(W - half - 4 * k, x)); // long names squeeze to fit the stage
    ctx.fillStyle = st.color;
    ctx.strokeText(label, lx, ground + 23 * k, fit);
    ctx.fillText(label, lx, ground + 23 * k, fit);
    const title = cosmetics?.TITLES[L.title as string]; // as: an unset title reads TITLES[undefined], which is no title
    if (title) {
      ctx.font = "bold " + Math.round(14 * k) + "px system-ui, sans-serif";
      ctx.lineWidth = 3 * k;
      ctx.fillStyle = "#fde68a";
      ctx.strokeText(title, lx, ground + 39 * k);
      ctx.fillText(title, lx, ground + 39 * k);
    }
    const taunt = win && cosmetics?.TAUNTS[L.taunt as string]; // as: an unset taunt reads TAUNTS[undefined], no taunt
    if (taunt) {
      ctx.font = "bold " + Math.round(14 * k) + "px system-ui, sans-serif";
      const bw = Math.min(W, ctx.measureText(taunt).width + 16 * k),
        top = ground - s - 33 * k,
        bx = Math.max(bw / 2, Math.min(W - bw / 2, x));
      ctx.fillStyle = "rgba(18,18,26,.88)";
      ctx.fillRect(bx - bw / 2, top, bw, 25 * k);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(taunt, bx, top + 18 * k, Math.max(1, bw - 8 * k));
    }
  }
  onLooksReady(canvas, kick);
  new ResizeObserver(kick).observe(canvas);
  kick();
  return {
    set(next: Partial<Stage>) {
      Object.assign(st, next);
      if (next.entry) image(next.entry.url).addEventListener("load", kick, { once: true });
      if (next.pet?.url) image(next.pet.url).addEventListener("load", kick, { once: true });
      kick();
    },
    // Plays the win effect and taunt once; false when there is neither.
    play() {
      if (!st.looks?.winEffect && !st.looks?.taunt) return false;
      st.win = { start: performance.now(), seed: Math.floor(Math.random() * 996) + 1 };
      kick();
      setTimeout(kick, 4600); // a still page clears the win frame afterwards
      return true;
    },
  };
}
