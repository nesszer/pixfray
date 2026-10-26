// Character sprites from the catalogs, uploaded pet images, and the frame a fighter shows.
import { opaqueBox } from "./pixels.ts";
import type { Frame } from "./pixels.ts";
import type { Head } from "./hats.ts";
import { channel } from "./overlay-stage.ts";
import type { Player } from "./overlay-stage.ts";

/** A character catalog entry (assets/characters.json, /api/catalog) as addSprite reads it. */
type CatalogItem = {
  url?: unknown;
  frames?: unknown;
  animations?: Record<string, unknown>;
  fps?: unknown;
  custom?: unknown;
  mode?: unknown;
  combatFallback?: unknown;
  head?: Head | null;
};
export type Sprite = Omit<CatalogItem, "frames" | "animations" | "fps"> & {
  frames: Frame[];
  animations: Record<string, Frame[]>;
  image: HTMLImageElement;
  loaded: boolean;
  fps: number;
  fit?: number;
};
export const sprites = new Map<string, Sprite>();
/** The built-in characters a chatter without a saved look gets at random; the entry fills it. */
export const ids: string[] = [];
export const missingAvatars = new Set<string>();
export let lastCatalogFetch = 0;

const validFrames = (list: unknown): Frame[] =>
  Array.isArray(list)
    ? list.filter((f) => f && [f.x, f.y, f.w, f.h].every(Number.isFinite) && f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0)
    : [];
// Packs crop their frames differently: a frog or a pixel hero fills its frame, a Kenney adventurer leaves margin.
// Shrink bulky figures (sqrt of the visible width x height in the standing frame, in frame heights) so every fighter
// has about the same on-stage size. 0.78 keeps the original characters as they were.
function bulkFit(image: HTMLImageElement, frame: Frame) {
  const b = opaqueBox(image, frame);
  return b ? Math.min(1, 0.78 / (Math.sqrt((b.right - b.left + 1) * (b.bottom - b.top + 1)) / frame.h)) : 1;
}
function addSprite(id: string, item: CatalogItem) {
  if (!item || typeof item.url !== "string" || sprites.has(id)) return;
  const url = new URL(item.url, location.href);
  if (url.origin !== location.origin) return;
  const animations: Record<string, Frame[]> = {};
  for (const [name, list] of Object.entries(item.animations || {})) {
    const frames = validFrames(list);
    if (frames.length) animations[name] = frames;
  }
  const image = new Image();
  const sprite: Sprite = {
    ...item,
    frames: validFrames(item.frames),
    animations,
    image,
    loaded: false,
    fps: Math.max(1, Math.min(30, Number(item.fps) || 8)),
  };
  image.onload = () => {
    if (!sprite.frames.length && image.naturalWidth && image.naturalHeight)
      sprite.frames = [{ x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight }];
    sprite.loaded = sprite.frames.length > 0;
    if (sprite.loaded) sprite.fit = bulkFit(image, sprite.frames[0]!); // loaded means frames is not empty
  };
  image.onerror = () => {
    sprite.loaded = false;
  };
  image.src = url.href;
  sprites.set(id, sprite);
}
// Adds every character of a catalog (an array, docs/CONTRACTS.md section 5); false when it could not be read.
export async function addCatalog(url: string) {
  try {
    const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) return false;
    const data = await response.json();
    for (const item of Array.isArray(data) ? data : [])
      if (typeof item?.id === "string") addSprite(item.id.toLowerCase(), item);
    return true;
  } catch {
    return false;
  }
}
// Custom characters can be uploaded while OBS is running; fetch the merged catalog again when one is missing.
export async function loadArenaCatalog() {
  lastCatalogFetch = Date.now();
  await addCatalog(`/api/catalog/${encodeURIComponent(channel)}`); // on failure the bundled sprite set stays
}

// Uploaded pets are PNGs served by /api/pets/<channel>/<id>; built-in pets are drawn in code (src/served/pets.ts).
const petImages = new Map<string, { image: HTMLImageElement }>();
export function petArt(id: string) {
  if (!/^p-[a-z0-9-]{1,40}$/.test(id)) return id;
  if (!petImages.has(id)) {
    const img = new Image();
    img.src = `/api/pets/${encodeURIComponent(channel)}/${id}`;
    petImages.set(id, { image: img });
  }
  return petImages.get(id);
}

// Picks the animation for the current action. Characters without drawn attack/ko frames (combatFallback "effects", or
// a single-PNG custom character) get engine-driven motion instead (drawn: false).
export function frameFor(sprite: Sprite, p: Player, now: number, moving: boolean): { frame: Frame; drawn?: boolean } {
  const a = sprite.animations || {};
  const anim = p.anim && now < p.anim.until ? p.anim : null;
  // addSprite keeps only frame lists that are not empty, and each index below stays inside its list
  const at = (list: Frame[], i: number) => list[Math.max(0, Math.min(list.length - 1, Math.floor(i)))]!;
  const pick = (list: Frame[]) => list[Math.floor(((now + p.phase) / 1000) * sprite.fps) % list.length]!;
  // "effects" characters only have an upright hurt frame for ko, so the engine still tips them over.
  if (p.koUntil > now && a.ko)
    return {
      frame: at(a.ko, ((now - (p.koStart || now)) / 1000) * sprite.fps),
      drawn: sprite.combatFallback !== "effects",
    };
  if (anim?.kind === "attack" && a.attack)
    return { frame: at(a.attack, ((now - anim.start) / (anim.until - anim.start)) * a.attack.length), drawn: true };
  if (anim?.kind === "cheer" && a.cheer) return { frame: pick(a.cheer), drawn: true };
  if (p.vy < 0 && a.jump) return { frame: a.jump[0]!, drawn: true };
  return { frame: pick((moving && a.walk) || (!moving && a.idle) || sprite.frames) };
}
