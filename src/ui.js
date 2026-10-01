// Shared helpers for the viewer dashboard and the admin page (Lane B). No framework.
export const CHANNEL = "nesszerra";
export const DEFAULT_COLOR = "#a78bfa";
export const DEFAULT_ABILITIES = { strike: { damage: 10, cooldownMs: 3000 }, heavy: { damage: 25, cooldownMs: 8000 }, heal: { amount: 15, cooldownMs: 10000 } };
export const ABILITY_NAMES = { strike: "Strike", heavy: "Heavy strike", heal: "Heal" };

// JSON fetch that never throws: {ok, status, data}. Same-origin, so POSTs carry the Origin header the Worker requires.
export async function api(path, { method = "GET", body } = {}) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  let response;
  try { response = await fetch(path, init); } catch { return { ok: false, status: 0, data: { error: "Network error; check your connection" } }; }
  let data = null;
  try { data = await response.json(); } catch {}
  return { ok: response.ok, status: response.status, data };
}
export const errorText = (r, fallback = "Request failed") => (r.data && (r.data.error || r.data.reason)) || (r.status ? fallback + " (HTTP " + r.status + ")" : fallback);

// Tiny DOM builder. Strings become text nodes, so user-supplied names are never parsed as HTML.
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style" && typeof value === "object") for (const [p, v] of Object.entries(value)) node.style.setProperty(p, v);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
export const $ = (selector, root = document) => root.querySelector(selector);
export function setStatus(node, message, kind = "") { node.textContent = message || ""; node.className = "status" + (kind ? " " + kind : ""); }

export const seconds = (ms) => { const s = ms / 1000; return (Number.isInteger(s) ? s : s.toFixed(2).replace(/0+$/, "")) + " s"; };
export function abilityDetail(name, spec = {}) {
  const cd = Number.isInteger(spec.cooldownMs) ? seconds(spec.cooldownMs) + " cooldown" : "";
  if (name === "heal") return (spec.amount ?? "?") + " HP heal, " + cd;
  return (spec.damage ?? "?") + " damage, " + cd;
}
export function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + " s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ms).toLocaleDateString();
}
export const dateTime = (ms) => ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
export const formatBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";

// Fills the signed-in area of the top bar on both pages.
export function renderWho(container, session, onSignOut) {
  container.replaceChildren();
  if (session?.user) {
    container.append(h("span", {}, "Signed in as ", h("strong", {}, session.user.displayName || session.user.login)),
      h("button", { class: "btn btn-small", type: "button", onclick: onSignOut }, "Sign out"));
  } else if (session && session.configured === false) {
    container.append(h("span", {}, "Twitch sign-in is not configured on this server yet"));
  } else {
    container.append(h("a", { class: "btn btn-primary", href: "/auth/login" }, "Sign in with Twitch"));
  }
}
export async function signOut() {
  await api("/auth/logout", { method: "POST" });
  location.reload();
}

// ---------- sprite previews ----------
// One requestAnimationFrame loop drives every animated canvas. Thumbnails stay on a still frame and animate only
// while hovered, focused or selected; the main preview loops the walk cycle. prefers-reduced-motion keeps all still.
const images = new Map();
const sprites = new Set();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function image(url) {
  if (!images.has(url)) { const img = new Image(); img.decoding = "async"; img.src = url; images.set(url, img); }
  return images.get(url);
}
export const framesFor = (entry, anim) => {
  const a = entry?.animations || {};
  const list = anim === "idle" ? a.idle || entry?.frames : anim === "walk" ? a.walk || entry?.frames : a[anim] || a.idle || entry?.frames;
  return Array.isArray(list) && list.length ? list : [];
};
export function drawFrame(canvas, entry, frame) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const img = entry && image(entry.url);
  if (!frame || !img.complete || !img.naturalWidth) return false;
  const scale = Math.min(canvas.width / frame.w, canvas.height / frame.h);
  const w = Math.round(frame.w * scale), h2 = Math.round(frame.h * scale);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, Math.round((canvas.width - w) / 2), canvas.height - h2, w, h2);
  return true;
}
// sprite = {canvas, entry, anim, active()} ; returns a handle with .set(entry) and .destroy()
export function addSprite(canvas, entry, { anim = "walk", active = () => true } = {}) {
  const s = { canvas, entry, anim, active, drawn: "" };
  sprites.add(s);
  const img = entry && image(entry.url);
  img?.addEventListener("load", () => { s.drawn = ""; }, { once: true });
  start();
  return { set(next) { s.entry = next; s.drawn = ""; if (next) image(next.url).addEventListener("load", () => { s.drawn = ""; }, { once: true }); start(); }, destroy() { sprites.delete(s); } };
}
let running = false;
function start() { if (!running) { running = true; requestAnimationFrame(tick); } }
function tick(now) {
  for (const s of sprites) {
    if (!s.canvas.isConnected) { sprites.delete(s); continue; }
    const moving = !reducedMotion.matches && s.active();
    const frames = framesFor(s.entry, moving ? s.anim : "idle");
    const index = moving && frames.length ? Math.floor(now / (1000 / (s.entry?.fps || 8))) % frames.length : 0;
    const key = (s.entry?.id || "") + ":" + (moving ? s.anim : "idle") + ":" + index;
    if (key !== s.drawn && drawFrame(s.canvas, s.entry, frames[index])) s.drawn = key;
  }
  if (sprites.size) requestAnimationFrame(tick); else running = false;
}
