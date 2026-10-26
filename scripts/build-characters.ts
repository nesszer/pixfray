// Builds the v3 built-in character atlases (public/assets/<id>.png) and their entries in public/assets/characters.json
// from the original CC0 source archives, and copies each pack's license notice byte-for-byte.
//
//   node scripts/build-characters.ts --download   fetch missing archives into .asset-src/ (sha256 checked), then build
//   node scripts/build-characters.ts              build from archives already in .asset-src/ (or ASSET_SRC=<dir>)
//   node scripts/build-characters.ts --check      verify archive hashes only
//
// Needs only Node (zlib/crypto/fs); the PNG and ZIP handling lives in scripts/lib/. Re-running is deterministic: the
// same archives always produce the same PNG bytes and the same JSON. The 15 launch characters (Kenney Platformer
// Characters, Toon Characters, Platformer Art Deluxe aliens) are never touched; only ids listed in CHARACTERS below
// are written, and they are always appended after the existing entries.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as png from "./lib/png-io.ts";
import { readZip, type Zip } from "./lib/zip-read.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.resolve(process.env.ASSET_SRC || path.join(root, ".asset-src"));
const outDir = path.join(root, "public", "assets");
const catalogFile = path.join(outDir, "characters.json");
const args = new Set(process.argv.slice(2));
const MAX_FRAME = 128;

// ---------------------------------------------------------------- packs
// The pinned archives, in sha256sum format.
const SHA256 = new Map(
  `
553b907f3f0e505ab65f56f245ccaff3123c8fe3f3a0dfce9373b996bfc18cc2  kenney_new-platformer-pack-1.1.zip
d01a196dbe3cc964e00d83ba3b987df62f332dc9260c9f941b4fbcc9047130f4  kenney_pixel-platformer.zip
e435582cf1dc5b320e109f785397ca740c7039e1124d7849dff2e5171e6832df  kenney_abstract-platformer.zip
eca9d66cd3f31eb186e2e73fb531c0d9ff1283376ca5a5195680d4995ac35bf9  kenney_jumper-pack.zip
84a1355be8af79d9077c84ce90f536af8d5be9ab8e449d383122053c9cb089b7  oga_FreeKnight.zip
5c2370c9a107b4e86b290159a23ea16154fe5179d072fe8adf65a1ed08d07265  oga_SantaSprites.zip
2a58cb74be07b3cb677a9ed4a9f372bb01cbfc6abcfeb3ffdc8d3eb54ae98b89  oga_NinjaAdventure.zip
dee3c944f21cac7475d9f107d7055c07a7acdc4f2eb7612be48c2842417749d5  oga_AdventureGirl.zip
e60f863e5abdce6fcded54f6b82bbda752ba0b555bc69c76c7da42d692e7b47c  oga_CatnDog.zip
d6d005f32e6d64c4187c911be2e3f19ceab7ef915d70be432ce9cd8ef52abb33  oga_TempleRun.zip
facd021364fba2cfb25c21172ce890aea1bedbebab437be51c4426ee0dc9257d  oga_CuteGirlFiles.zip
386a223a9540f24654bc5d305369e5e390c80fd25d78f0b1c296f063375f39de  oga_JackFree.zip
6fa7c8de581b6f35029261f7f2dfe5dbe0a79c493ba960f7c932a741188d85c6  oga_NinjaGirl.zip
8ce021bdda109c2d0b32458d0c25511b4b02888cd41bcfb8d917676e54a3dcfb  oga_redhatfiles.zip
d105576e4fa1cba4ac54752176b9d5aa20fdc0be1cb41c30635e8845e28f99b1  oga_FlatBoy.zip
f9ae663c870a63c11fc3c4a825d420256503e98ad3351561e79af272aa7396e0  oga_RobotFree.zip
acc903a48fbfc3277ee5ffbea8a85682965c8ba728f21f799e17798aca4126d8  oga_turtle_4.png
a0b84c84bb0ab08d2f8d6eab7e998efa10a54c5866fc782865c442bb46073173  oga_FreeDinoSprite.zip
`
    .trim()
    .split("\n")
    .map((line) => line.split("  ").reverse() as [string, string]), // as: every line is "<sha256>  <file>"
);
// One source archive (or a single sprite sheet when `sheet` is set) and the license file copied out of it.
type Pack = {
  source: string;
  file: string;
  url: string;
  license?: { entry: string; out: string };
  sheet?: { w: number; h: number };
};
const OGA = "https://opengameart.org/sites/default/files/";
// An OpenGameArt pack: its page under /content/ and the file name it is downloaded under.
const oga = (page: string, name: string, extra: Partial<Pack> = {}): Pack => ({
  source: "https://opengameart.org/content/" + page,
  file: "oga_" + name,
  url: OGA + name,
  ...extra,
});
// A Kenney pack: its page under /assets/<slug>, the archive under that page's media folder `dir` (file name
// kenney_<slug><version>.zip), and its License.txt copied to KENNEY_<name>_LICENSE.txt.
const kenney = (slug: string, dir: string, name: string, version = ""): Pack => ({
  source: "https://kenney.nl/assets/" + slug,
  file: `kenney_${slug}${version}.zip`,
  url: `https://kenney.nl/media/pages/assets/${slug}/${dir}/kenney_${slug}${version}.zip`,
  license: { entry: "License.txt", out: `KENNEY_${name}_LICENSE.txt` },
});
const PACK_TABLE = {
  "kenney-new-platformer": kenney("new-platformer-pack", "1896103897-1764756702", "NEW_PLATFORMER", "-1.1"),
  "kenney-pixel-platformer": kenney("pixel-platformer", "33bb4921eb-1696667883", "PIXEL_PLATFORMER"),
  "kenney-abstract-platformer": kenney("abstract-platformer", "a8f4badcb5-1677579172", "ABSTRACT_PLATFORMER"),
  "kenney-jumper": kenney("jumper-pack", "4654b2d2e5-1677666699", "JUMPER"),
  // OpenGameArt packs by pzUH. The archives carry no license file; the CC0 statement is on each OpenGameArt page and is
  // recorded in public/assets/OGA_PZUH_LICENSE.txt (written by hand, not generated here).
  "oga-knight": oga("the-knight-free-sprite", "FreeKnight.zip"),
  "oga-santa": oga("santa-claus-free-sprites", "SantaSprites.zip"),
  "oga-ninja": oga("ninja-adventure-free-sprite", "NinjaAdventure.zip"),
  "oga-adventure-girl": oga("adventurer-girl-free-sprite", "AdventureGirl.zip", { url: OGA + "Adventure%20Girl.zip" }),
  "oga-cat-dog": oga("cat-dog-free-sprites", "CatnDog.zip"),
  "oga-temple-run": oga("temple-run-free-sprite", "TempleRun.zip"),
  "oga-cute-girl": oga("cute-girl-free-sprites", "CuteGirlFiles.zip"),
  "oga-jack": oga("jack-o-lantern-free-sprite", "JackFree.zip"),
  "oga-ninja-girl": oga("ninja-girl-free-sprite", "NinjaGirl.zip"),
  "oga-red-hat-boy": oga("red-hat-boy-free-sprites", "redhatfiles.zip"),
  "oga-flat-boy": oga("the-boy-free-sprites", "FlatBoy.zip"),
  "oga-robot": oga("the-robot-free-sprite", "RobotFree.zip"),
  // A single sprite sheet rather than an archive: `sheet` gives the tile size, and frames are named "tile <n>" (left to right).
  // The CC0 statement is on the OpenGameArt page, recorded in public/assets/OGA_SOGOMN_LICENSE.txt (written by hand).
  "oga-turtle": oga("animated-turtle", "turtle_4.png", { sheet: { w: 32, h: 32 } }),
  "oga-dino": oga("free-dino-sprites", "FreeDinoSprite.zip"),
} satisfies Record<string, Pack>;
type PackId = keyof typeof PACK_TABLE;
const PACKS: Record<PackId, Pack> = PACK_TABLE;

// ---------------------------------------------------------------- characters
// Frame names in a folder. `p(dir)(name, list)` -> "dir/name (3).png"; `u(dir)(name, list)` -> "dir/name__003.png".
type Names = (name: string, list: number[]) => string[];
function p(dir: string): Names {
  return (name, list) => list.map((i) => `${dir}${name} (${i}).png`);
}
function u(dir: string): Names {
  return (name, list) => list.map((i) => `${dir}${name}__${String(i).padStart(3, "0")}.png`);
}
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const odds = (to: number): number[] => range(1, to).filter((i) => i % 2 === 1); // 1, 3, 5 ... up to `to`

// Source file names per animation (zip entries, or "tile <n>" for a sheet).
type Frames = { walk: string[]; idle: string[]; jump: string[]; cheer: string[]; attack?: string[]; ko?: string[] };
// Where hats go when it isn't the top of the figure, as fractions of the cell (src/served/hats.ts).
type Head = { top: number; left: number; right: number };
type Character = Frames & {
  id: string;
  label: string;
  pack: PackId;
  fps: number;
  scale: { height?: number; smooth?: number; pixel?: number };
  head?: Head;
};

// scale: {height: px} fits the walk/idle height to px (area-average downscale), {smooth: n} integer bilinear upscale,
// {pixel: n} integer nearest-neighbour upscale (pixel art), {} native size. Nothing may end up above 128 x 128.
function char(pack: PackId, fps: number, scale: Character["scale"], id: string, label: string, o: Frames): Character {
  return { id, label, pack, fps, scale, ...o };
}
const npp = (colour: string, id: string, label: string): Character => {
  const d = `Sprites/Characters/Default/character_${colour}_`;
  return char("kenney-new-platformer", 6, {}, id, label, {
    walk: [`${d}walk_a.png`, `${d}walk_b.png`],
    idle: [`${d}idle.png`],
    jump: [`${d}jump.png`],
    cheer: [`${d}front.png`, `${d}jump.png`],
    ko: [`${d}hit.png`],
  });
};
const ENEMIES = "Sprites/Enemies/Default/";
const nppBug = (name: string, id: string, label: string, jump: string, extra: Partial<Character> = {}): Character => ({
  ...char("kenney-new-platformer", 6, { smooth: 2 }, id, label, {
    walk: [`${ENEMIES}${name}_walk_a.png`, `${ENEMIES}${name}_walk_b.png`],
    idle: [`${ENEMIES}${name}_rest.png`],
    jump: [`${ENEMIES}${jump}.png`],
    cheer: [`${ENEMIES}${name}_rest.png`, `${ENEMIES}${jump}.png`],
  }),
  ...extra,
});
const tiles = (list: string[]): string[] => list.map((t) => `Tiles/Characters/tile_${t}.png`);
const pixel = (a: string, b: string, id: string, label: string): Character =>
  char("kenney-pixel-platformer", 6, { pixel: 4 }, id, label, {
    walk: tiles([a, b]),
    idle: tiles([a]),
    jump: tiles([b]),
    cheer: tiles([a, b]),
  });
const blob = (colour: string, id: string, label: string): Character => {
  const d = `PNG/Players/Player ${colour}/player${colour}_`;
  return char("kenney-abstract-platformer", 10, { smooth: 2 }, id, label, {
    walk: range(1, 5).map((i) => `${d}walk${i}.png`),
    idle: [`${d}stand.png`],
    jump: [`${d}up2.png`],
    cheer: [`${d}up1.png`, `${d}up2.png`],
    ko: [`${d}hit.png`, `${d}dead.png`],
  });
};
// pzUH characters are big (400-900 px) side views: scaled down to ~104 px tall. 10 fps over 10 frames = one stride per second.
// Columns after the label: the frame names, walk [name, frames], Idle frames, the Jump frame, then cheer's distance either
// side of the jump frame (`spread`, default 2) and the optional attack and ko [name, frames].
type PzMore = { spread?: number; attack?: [string, number[]]; ko?: [string, number[]] };
function pz(
  pack: PackId,
  id: string,
  label: string,
  f: Names,
  walk: [string, number[]],
  idle: number[],
  jump: number,
  { spread = 2, attack, ko }: PzMore = {},
): Character {
  return char(pack, 10, { height: 104 }, id, label, {
    walk: f(...walk),
    idle: f("Idle", idle),
    jump: f("Jump", [jump]),
    cheer: f("Jump", [jump - spread, jump + spread]),
    ...(attack ? { attack: f(...attack) } : {}),
    ...(ko ? { ko: f(...ko) } : {}),
  });
}

// Kenney Jumper Pack: big flat-colour sprites, scaled down like the pzUH ones. Frame lists are file names without ".png".
const jumper = (dir: string, id: string, label: string, o: Frames): Character => {
  // as: fromEntries returns a string-keyed record; it maps each frame list of o to the same key, so it is Frames again
  const files = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((n) => `PNG/${dir}/${n}.png`)]));
  return char("kenney-jumper", 6, { height: 104 }, id, label, files as Frames);
};
// A Jumper Pack figure with name_walk1/2, name_stand and name_jump frames.
const walker = (name: string, cheer: string, ko?: string): Frames => ({
  walk: [`${name}_walk1`, `${name}_walk2`],
  idle: [`${name}_stand`],
  jump: [`${name}_jump`],
  cheer: [`${name}_${cheer}`, `${name}_jump`],
  ...(ko ? { ko: [`${name}_${ko}`] } : {}),
});

const CHARACTERS: Character[] = [
  pz("oga-knight", "knight", "Knight", p("png/"), ["Walk", range(1, 10)], range(1, 10), 5, {
    attack: ["Attack", [1, 3, 5, 7, 9]],
    ko: ["Dead", [1, 4, 7, 10]],
  }),
  pz("oga-santa", "santa", "Santa", p("png/"), ["Walk", range(1, 13)], odds(15), 8, { spread: 3 }),
  pz("oga-ninja", "ninja", "Ninja", u("png/"), ["Run", range(0, 9)], range(0, 9), 5, {
    attack: ["Attack", [0, 2, 4, 6, 8]],
    ko: ["Dead", [0, 3, 6, 9]],
  }),
  pz("oga-adventure-girl", "cowgirl", "Cowgirl", p("png/"), ["Run", range(1, 8)], range(1, 10), 5, {
    attack: ["Melee", range(1, 7)],
    ko: ["Dead", [1, 4, 7, 10]],
  }),
  pz("oga-temple-run", "cowboy", "Cowboy", u(""), ["Run", range(0, 9)], range(0, 9), 5),
  pz("oga-cat-dog", "cat", "Cat", p("png/cat/"), ["Walk", range(1, 10)], range(1, 10), 4, { ko: ["Hurt", [4]] }),
  pz("oga-cat-dog", "dog", "Dog", p("png/dog/"), ["Walk", range(1, 10)], range(1, 10), 4, { ko: ["Hurt", [4]] }),
  pz("oga-dino", "dino", "Dino", p("png/"), ["Walk", range(1, 10)], range(1, 10), 6, { ko: ["Dead", [1, 3, 5, 8]] }),
  pz("oga-cute-girl", "cute-girl", "Cute Girl", p("png/"), ["Walk", odds(19)], odds(15), 15, {
    spread: 7,
    ko: ["Dead", [1, 10, 20, 30]],
  }),
  pz("oga-jack", "pumpkin", "Pumpkin", p("png/"), ["Walk", range(1, 10)], range(1, 10), 5, {
    ko: ["Dead", [1, 4, 7, 10]],
  }),
  pz("oga-ninja-girl", "ninja-girl", "Ninja Girl", u("png/"), ["Run", range(0, 9)], range(0, 9), 5, {
    attack: ["Attack", [0, 2, 4, 6, 8]],
    ko: ["Dead", [0, 3, 6, 9]],
  }),
  pz("oga-red-hat-boy", "red-hat-boy", "Red Hat Boy", p("png/"), ["Run", range(1, 8)], range(1, 10), 6),
  pz("oga-flat-boy", "flat-boy", "Kid", p("png/"), ["Walk", odds(15)], odds(15), 8, { spread: 3 }),
  pz("oga-robot", "robot", "Gold Robot", p("png/"), ["Run", range(1, 8)], range(1, 10), 5, {
    attack: ["Melee", range(1, 8)],
    ko: ["Dead", [1, 4, 7, 10]],
  }),
  jumper("Players", "bunny-brown", "Brown Bunny", walker("bunny1", "ready", "hurt")),
  jumper("Players", "bunny-purple", "Purple Bunny", walker("bunny2", "ready", "hurt")),
  jumper("Enemies", "spike-man", "Spike Man", walker("spikeMan", "stand")),
  jumper("Enemies", "fly-man", "Propeller", {
    walk: ["flyMan_fly", "flyMan_still_fly"],
    idle: ["flyMan_stand"],
    jump: ["flyMan_jump"],
    cheer: ["flyMan_stand", "flyMan_jump"],
  }),
  {
    ...jumper("Enemies", "wing-man", "Wing Bird", {
      walk: [1, 2, 3, 4, 5, 4, 3, 2].map((i) => `wingMan${i}`),
      idle: ["wingMan1"],
      jump: ["wingMan3"],
      cheer: ["wingMan1", "wingMan5"],
    }),
    fps: 12,
  },
  npp("green", "npp-mint", "Mint Astronaut"),
  npp("purple", "npp-violet", "Violet Astronaut"),
  npp("pink", "npp-rose", "Rose Astronaut"),
  npp("yellow", "npp-gold", "Gold Astronaut"),
  npp("beige", "npp-sand", "Sand Astronaut"),
  nppBug("ladybug", "npp-ladybug", "Ladybug", "ladybug_fly"),
  nppBug("snail", "npp-snail", "Snail", "snail_walk_b"),
  nppBug("mouse", "npp-mouse", "Mouse", "mouse_walk_b"),
  nppBug("frog", "npp-frog", "Frog", "frog_jump", {
    fps: 4,
    walk: [`${ENEMIES}frog_idle.png`, `${ENEMIES}frog_jump.png`],
  }),
  pixel("0000", "0001", "pixel-green", "Pixel Green"),
  pixel("0002", "0003", "pixel-blue", "Pixel Blue"),
  pixel("0004", "0005", "pixel-pink", "Pixel Pink"),
  pixel("0006", "0007", "pixel-yellow", "Pixel Yellow"),
  pixel("0009", "0010", "pixel-diver", "Pixel Diver"),
  pixel("0011", "0012", "pixel-block", "Angry Block"),
  pixel("0015", "0016", "pixel-spike", "Spike Helmet"),
  pixel("0021", "0022", "pixel-bot", "Pixel Robot"),
  { ...pixel("0024", "0025", "pixel-bat", "Pixel Bat"), walk: tiles(["0024", "0025", "0026", "0025"]) },
  blob("Blue", "blob-blue", "Blue Blob"),
  blob("Green", "blob-green", "Green Blob"),
  blob("Red", "blob-red", "Red Blob"),
  {
    ...char("oga-turtle", 6, { pixel: 4 }, "turtle", "Turtle", {
      walk: ["tile 0", "tile 1", "tile 2", "tile 3"],
      idle: ["tile 0"],
      jump: ["tile 1"],
      cheer: ["tile 0", "tile 2"],
    }),
    head: { top: 0, left: 0.73, right: 0.98 }, // the head pokes out on the right; the top of the figure is shell
  },
];

// ---------------------------------------------------------------- sources
const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

async function download() {
  fs.mkdirSync(srcDir, { recursive: true });
  for (const [name, pack] of Object.entries(PACKS)) {
    const file = path.join(srcDir, pack.file);
    if (fs.existsSync(file)) continue;
    console.log("download " + name + " <- " + pack.url);
    const res = await fetch(pack.url, { headers: { "user-agent": "mini-chat-asset-build" } });
    if (!res.ok) throw new Error(name + ": HTTP " + res.status);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
}

// A pack's opened source: frame images by name, and the archive itself when it is a ZIP (for the license file).
type Source = { image: (name: string) => png.Image; zip?: Zip };
const sources = new Map<PackId, Source>();
function open(pack: PackId): Source {
  const { file, sheet } = PACKS[pack];
  const known = sources.get(pack);
  if (known) return known;
  const full = path.join(srcDir, file);
  if (!fs.existsSync(full)) throw new Error("missing " + full + " (run with --download)");
  const buf = fs.readFileSync(full);
  if (sha256(buf) !== SHA256.get(file))
    throw new Error(file + " sha256 " + sha256(buf) + " does not match the pinned " + SHA256.get(file));
  let source: Source;
  if (sheet) {
    const img = png.decodePng(buf),
      cols = img.width / sheet.w;
    const tile = (n: number) => png.crop(img, { x: (n % cols) * sheet.w, y: Math.floor(n / cols) * sheet.h, ...sheet });
    source = { image: (name) => tile(Number(/^tile (\d+)$/.exec(name)?.[1])) };
  } else {
    const zip = readZip(buf);
    source = { image: (name) => png.decodePng(zip.read(name)), zip };
  }
  sources.set(pack, source);
  return source;
}

// One source frame: its canvas size, the bounds of its opaque pixels and the decoded image.
type Frame = { canvas: { w: number; h: number }; box: png.Rect; img: png.Image };
function loadFrame(pack: PackId, name: string): Frame {
  const img = open(pack).image(name);
  const box = png.alphaBounds(img);
  if (!box) throw new Error(pack + ": " + name + " is empty");
  return { canvas: { w: img.width, h: img.height }, box, img };
}

// ---------------------------------------------------------------- atlas
const ATLAS_ORDER = ["walk", "idle", "jump", "attack", "ko", "cheer"] as const; // as const: the frame list keys
const JSON_ORDER = ["idle", "walk", "jump", "cheer", "attack", "ko"] as const; // as const: the frame list keys

function buildCharacter(c: Character) {
  const order = [...new Set(ATLAS_ORDER.flatMap((r) => c[r] ?? []))]; // unique source files, in atlas order
  const frames = new Map<string, Frame>(order.map((f) => [f, loadFrame(c.pack, f)]));
  // !: order holds every walk and idle file and frames has an entry for each; walk is never empty, so base[0] exists
  const base = [...c.walk, ...c.idle].map((f) => frames.get(f)!);
  const first = base[0]!; // !: walk is never empty
  // Walk and idle frames that share a canvas keep the body on one column (no sway); other frames centre on their own bounds.
  const onFirstCanvas = (f: Frame) => f.canvas.w === first.canvas.w && f.canvas.h === first.canvas.h;
  const sameCanvas = base.every(onFirstCanvas);
  const cx = sameCanvas
    ? (Math.min(...base.map((f) => f.box.x)) + Math.max(...base.map((f) => f.box.x + f.box.w))) / 2
    : 0;
  const anchored = (f: Frame) => sameCanvas && onFirstCanvas(f);
  const left = (f: Frame) => (anchored(f) ? cx - f.box.x : f.box.w / 2),
    right = (f: Frame) => (anchored(f) ? f.box.x + f.box.w - cx : f.box.w / 2);

  const { pixel, smooth, height } = c.scale;
  const mode = pixel ? "pixel" : smooth ? "smooth" : "area";
  let scale = pixel ?? smooth ?? (height ? height / Math.max(...base.map((f) => f.box.h)) : 1);
  const all = [...frames.values()];
  const dims = () => ({
    halfW: Math.ceil(Math.max(...all.map((f) => Math.max(left(f), right(f)))) * scale),
    h: Math.ceil(Math.max(...all.map((f) => f.box.h)) * scale),
  });
  let d = dims();
  while (mode === "area" && (d.halfW * 2 > MAX_FRAME || d.h > MAX_FRAME)) {
    scale *= 0.98;
    d = dims();
  }
  const cw = d.halfW * 2,
    ch = d.h;
  if (cw > MAX_FRAME || ch > MAX_FRAME) throw new Error(c.id + ": cell " + cw + "x" + ch + " exceeds " + MAX_FRAME);

  const atlas = png.blank(cw * order.length, ch);
  order.forEach((name, i) => {
    const f = frames.get(name)!; // !: frames has an entry for every name in order
    let img = png.crop(f.img, f.box);
    if (mode === "pixel") img = png.resizeNearest(img, scale);
    else if (mode === "smooth") img = png.resizeBilinear(img, scale);
    else if (scale !== 1)
      img = png.resizeArea(img, Math.max(1, Math.round(f.box.w * scale)), Math.max(1, Math.round(f.box.h * scale)));
    const dx = anchored(f) ? d.halfW - Math.round(left(f) * scale) : Math.floor((cw - img.width) / 2);
    png.blit(atlas, img, i * cw + Math.max(0, Math.min(cw - img.width, dx)), ch - img.height);
  });
  const rects = (list: string[]): png.Rect[] => list.map((f) => ({ x: order.indexOf(f) * cw, y: 0, w: cw, h: ch }));
  const entry = {
    id: c.id,
    label: c.label,
    url: "/assets/" + c.id + ".png",
    frames: rects(c.walk),
    fps: c.fps,
    animations: Object.fromEntries(JSON_ORDER.flatMap((k) => (c[k] ? [[k, rects(c[k])]] : []))),
    anchor: { x: 0.5, y: 1 },
    license: "CC0-1.0",
    source: PACKS[c.pack].source,
    ...(c.head ? { head: c.head } : {}), // where hats go (src/served/hats.ts), when it isn't the top of the figure
    ...(c.attack ? {} : { combatFallback: "effects" }),
  };
  return { entry, png: png.encodePng(atlas), cell: cw + " x " + ch, frames: order.length };
}

// ---------------------------------------------------------------- main
if (args.has("--download")) await download();
if (args.has("--check")) {
  for (const { file } of Object.values(PACKS)) {
    const full = path.join(srcDir, file);
    const hash = fs.existsSync(full) ? sha256(fs.readFileSync(full)) : "missing".padEnd(64);
    console.log(`${hash}  ${file}  ${hash === SHA256.get(file) ? "ok" : "MISMATCH"}`);
  }
  process.exit(0);
}

const ids = new Set(CHARACTERS.map((c) => c.id));
const duplicate = CHARACTERS.find((c, i) => CHARACTERS.findIndex((o) => o.id === c.id) !== i);
if (duplicate) throw new Error("duplicate id " + duplicate.id);
const existing = JSON.parse(fs.readFileSync(catalogFile, "utf8")).filter((e: { id: string }) => !ids.has(e.id));
const built = CHARACTERS.map((c) => {
  const r = buildCharacter(c);
  fs.writeFileSync(path.join(outDir, c.id + ".png"), r.png);
  const size = Math.round(r.png.length / 1024);
  console.log(
    `${c.id.padEnd(16)}${c.label.padEnd(18)}${`cell ${r.cell}`.padEnd(14)}${`${r.frames} frames`.padEnd(11)}${size} KB`,
  );
  return r.entry;
});
fs.writeFileSync(catalogFile, JSON.stringify([...existing, ...built], null, 2) + "\n");

for (const pack of new Set(CHARACTERS.map((c) => c.pack))) {
  const { license } = PACKS[pack],
    zip = open(pack).zip;
  if (!license || !zip) continue;
  const text = zip.read(license.entry);
  const target = path.join(outDir, license.out);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(text)) fs.writeFileSync(target, text);
}
if (!fs.existsSync(path.join(outDir, "OGA_PZUH_LICENSE.txt")))
  console.warn("warning: public/assets/OGA_PZUH_LICENSE.txt is missing");
console.log(`\n${built.length} characters written; catalog now has ${existing.length + built.length} entries.`);
