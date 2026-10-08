// Builds the v3 built-in character atlases (public/assets/<id>.png) and their entries in public/assets/characters.json
// from the original CC0 source archives, and copies each pack's license notice byte-for-byte.
//
//   node scripts/build-characters.mjs --download   fetch missing archives into .asset-src/ (sha256 checked), then build
//   node scripts/build-characters.mjs              build from archives already in .asset-src/ (or ASSET_SRC=<dir>)
//   node scripts/build-characters.mjs --check      verify archive hashes only
//
// Needs only Node (zlib/crypto/fs); the PNG and ZIP handling lives in scripts/lib/. Re-running is deterministic: the
// same archives always produce the same PNG bytes and the same JSON. The 15 launch characters (Kenney Platformer
// Characters, Toon Characters, Platformer Art Deluxe aliens) are never touched; only ids listed in CHARACTERS below
// are written, and they are always appended after the existing entries.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readZip } from "./lib/zip-read.mjs";
import {
  decodePng,
  encodePng,
  alphaBounds,
  crop,
  resizeArea,
  resizeBilinear,
  resizeNearest,
  blank,
  blit,
} from "./lib/png-io.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.resolve(process.env.ASSET_SRC || path.join(root, ".asset-src"));
const outDir = path.join(root, "public", "assets");
const catalogFile = path.join(outDir, "characters.json");
const args = new Set(process.argv.slice(2));
const MAX_FRAME = 128;

// ---------------------------------------------------------------- packs
const OGA = "https://opengameart.org/sites/default/files/";
const PACKS = {
  "kenney-new-platformer": {
    source: "https://kenney.nl/assets/new-platformer-pack",
    file: "kenney_new-platformer-pack-1.1.zip",
    sha256: "553b907f3f0e505ab65f56f245ccaff3123c8fe3f3a0dfce9373b996bfc18cc2",
    url: "https://kenney.nl/media/pages/assets/new-platformer-pack/1896103897-1764756702/kenney_new-platformer-pack-1.1.zip",
    license: { entry: "License.txt", out: "KENNEY_NEW_PLATFORMER_LICENSE.txt" },
  },
  "kenney-pixel-platformer": {
    source: "https://kenney.nl/assets/pixel-platformer",
    file: "kenney_pixel-platformer.zip",
    sha256: "d01a196dbe3cc964e00d83ba3b987df62f332dc9260c9f941b4fbcc9047130f4",
    url: "https://kenney.nl/media/pages/assets/pixel-platformer/33bb4921eb-1696667883/kenney_pixel-platformer.zip",
    license: { entry: "License.txt", out: "KENNEY_PIXEL_PLATFORMER_LICENSE.txt" },
  },
  "kenney-abstract-platformer": {
    source: "https://kenney.nl/assets/abstract-platformer",
    file: "kenney_abstract-platformer.zip",
    sha256: "e435582cf1dc5b320e109f785397ca740c7039e1124d7849dff2e5171e6832df",
    url: "https://kenney.nl/media/pages/assets/abstract-platformer/a8f4badcb5-1677579172/kenney_abstract-platformer.zip",
    license: { entry: "License.txt", out: "KENNEY_ABSTRACT_PLATFORMER_LICENSE.txt" },
  },
  "kenney-jumper": {
    source: "https://kenney.nl/assets/jumper-pack",
    file: "kenney_jumper-pack.zip",
    sha256: "eca9d66cd3f31eb186e2e73fb531c0d9ff1283376ca5a5195680d4995ac35bf9",
    url: "https://kenney.nl/media/pages/assets/jumper-pack/4654b2d2e5-1677666699/kenney_jumper-pack.zip",
    license: { entry: "License.txt", out: "KENNEY_JUMPER_LICENSE.txt" },
  },
  // OpenGameArt packs by pzUH. The archives carry no license file; the CC0 statement is on each OpenGameArt page and is
  // recorded in public/assets/OGA_PZUH_LICENSE.txt (written by hand, not generated here).
  "oga-knight": {
    source: "https://opengameart.org/content/the-knight-free-sprite",
    file: "oga_FreeKnight.zip",
    sha256: "84a1355be8af79d9077c84ce90f536af8d5be9ab8e449d383122053c9cb089b7",
    url: OGA + "FreeKnight.zip",
  },
  "oga-santa": {
    source: "https://opengameart.org/content/santa-claus-free-sprites",
    file: "oga_SantaSprites.zip",
    sha256: "5c2370c9a107b4e86b290159a23ea16154fe5179d072fe8adf65a1ed08d07265",
    url: OGA + "SantaSprites.zip",
  },
  "oga-ninja": {
    source: "https://opengameart.org/content/ninja-adventure-free-sprite",
    file: "oga_NinjaAdventure.zip",
    sha256: "2a58cb74be07b3cb677a9ed4a9f372bb01cbfc6abcfeb3ffdc8d3eb54ae98b89",
    url: OGA + "NinjaAdventure.zip",
  },
  "oga-adventure-girl": {
    source: "https://opengameart.org/content/adventurer-girl-free-sprite",
    file: "oga_AdventureGirl.zip",
    sha256: "dee3c944f21cac7475d9f107d7055c07a7acdc4f2eb7612be48c2842417749d5",
    url: OGA + "Adventure%20Girl.zip",
  },
  "oga-cat-dog": {
    source: "https://opengameart.org/content/cat-dog-free-sprites",
    file: "oga_CatnDog.zip",
    sha256: "e60f863e5abdce6fcded54f6b82bbda752ba0b555bc69c76c7da42d692e7b47c",
    url: OGA + "CatnDog.zip",
  },
  "oga-temple-run": {
    source: "https://opengameart.org/content/temple-run-free-sprite",
    file: "oga_TempleRun.zip",
    sha256: "d6d005f32e6d64c4187c911be2e3f19ceab7ef915d70be432ce9cd8ef52abb33",
    url: OGA + "TempleRun.zip",
  },
  "oga-cute-girl": {
    source: "https://opengameart.org/content/cute-girl-free-sprites",
    file: "oga_CuteGirlFiles.zip",
    sha256: "facd021364fba2cfb25c21172ce890aea1bedbebab437be51c4426ee0dc9257d",
    url: OGA + "CuteGirlFiles.zip",
  },
  "oga-jack": {
    source: "https://opengameart.org/content/jack-o-lantern-free-sprite",
    file: "oga_JackFree.zip",
    sha256: "386a223a9540f24654bc5d305369e5e390c80fd25d78f0b1c296f063375f39de",
    url: OGA + "JackFree.zip",
  },
  "oga-ninja-girl": {
    source: "https://opengameart.org/content/ninja-girl-free-sprite",
    file: "oga_NinjaGirl.zip",
    sha256: "6fa7c8de581b6f35029261f7f2dfe5dbe0a79c493ba960f7c932a741188d85c6",
    url: OGA + "NinjaGirl.zip",
  },
  "oga-red-hat-boy": {
    source: "https://opengameart.org/content/red-hat-boy-free-sprites",
    file: "oga_redhatfiles.zip",
    sha256: "8ce021bdda109c2d0b32458d0c25511b4b02888cd41bcfb8d917676e54a3dcfb",
    url: OGA + "redhatfiles.zip",
  },
  "oga-flat-boy": {
    source: "https://opengameart.org/content/the-boy-free-sprites",
    file: "oga_FlatBoy.zip",
    sha256: "d105576e4fa1cba4ac54752176b9d5aa20fdc0be1cb41c30635e8845e28f99b1",
    url: OGA + "FlatBoy.zip",
  },
  "oga-robot": {
    source: "https://opengameart.org/content/the-robot-free-sprite",
    file: "oga_RobotFree.zip",
    sha256: "f9ae663c870a63c11fc3c4a825d420256503e98ad3351561e79af272aa7396e0",
    url: OGA + "RobotFree.zip",
  },
  // A single sprite sheet rather than an archive: `sheet` gives the tile size, and frames are named "tile <n>" (left to right).
  // The CC0 statement is on the OpenGameArt page, recorded in public/assets/OGA_SOGOMN_LICENSE.txt (written by hand).
  "oga-turtle": {
    source: "https://opengameart.org/content/animated-turtle",
    file: "oga_turtle_4.png",
    sha256: "acc903a48fbfc3277ee5ffbea8a85682965c8ba728f21f799e17798aca4126d8",
    url: OGA + "turtle_4.png",
    sheet: { w: 32, h: 32 },
  },
  "oga-dino": {
    source: "https://opengameart.org/content/free-dino-sprites",
    file: "oga_FreeDinoSprite.zip",
    sha256: "a0b84c84bb0ab08d2f8d6eab7e998efa10a54c5866fc782865c442bb46073173",
    url: OGA + "FreeDinoSprite.zip",
  },
};

// ---------------------------------------------------------------- characters
// Frame names. `p(dir, name, list)` -> "dir/name (3).png"; `u(dir, name, list)` -> "dir/name__003.png".
const p = (dir, name, list) => list.map((i) => `${dir}${name} (${i}).png`);
const u = (dir, name, list) => list.map((i) => `${dir}${name}__${String(i).padStart(3, "0")}.png`);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const every = (list, step, from = 0) => list.filter((_, i) => i >= from && (i - from) % step === 0);

// scale: {height: px} fits the walk/idle height to px (area-average downscale), {smooth: n} integer bilinear upscale,
// {pixel: n} integer nearest-neighbour upscale (pixel art), {} native size. Nothing may end up above 128 x 128.
const npp = (colour, id, label) => ({
  id,
  label,
  pack: "kenney-new-platformer",
  fps: 6,
  scale: {},
  walk: [
    `Sprites/Characters/Default/character_${colour}_walk_a.png`,
    `Sprites/Characters/Default/character_${colour}_walk_b.png`,
  ],
  idle: [`Sprites/Characters/Default/character_${colour}_idle.png`],
  jump: [`Sprites/Characters/Default/character_${colour}_jump.png`],
  cheer: [
    `Sprites/Characters/Default/character_${colour}_front.png`,
    `Sprites/Characters/Default/character_${colour}_jump.png`,
  ],
  ko: [`Sprites/Characters/Default/character_${colour}_hit.png`],
});
const nppBug = (name, id, label, jump, extra = {}) => ({
  id,
  label,
  pack: "kenney-new-platformer",
  fps: 6,
  scale: { smooth: 2 },
  walk: [`Sprites/Enemies/Default/${name}_walk_a.png`, `Sprites/Enemies/Default/${name}_walk_b.png`],
  idle: [`Sprites/Enemies/Default/${name}_rest.png`],
  jump: [`Sprites/Enemies/Default/${jump}.png`],
  cheer: [`Sprites/Enemies/Default/${name}_rest.png`, `Sprites/Enemies/Default/${jump}.png`],
  ...extra,
});
const pixel = (a, b, id, label) => ({
  id,
  label,
  pack: "kenney-pixel-platformer",
  fps: 6,
  scale: { pixel: 4 },
  walk: [`Tiles/Characters/tile_${a}.png`, `Tiles/Characters/tile_${b}.png`],
  idle: [`Tiles/Characters/tile_${a}.png`],
  jump: [`Tiles/Characters/tile_${b}.png`],
  cheer: [`Tiles/Characters/tile_${a}.png`, `Tiles/Characters/tile_${b}.png`],
});
const blob = (colour, id, label) => {
  const d = `PNG/Players/Player ${colour}/player${colour}_`;
  return {
    id,
    label,
    pack: "kenney-abstract-platformer",
    fps: 10,
    scale: { smooth: 2 },
    walk: range(1, 5).map((i) => `${d}walk${i}.png`),
    idle: [`${d}stand.png`],
    jump: [`${d}up2.png`],
    cheer: [`${d}up1.png`, `${d}up2.png`],
    ko: [`${d}hit.png`, `${d}dead.png`],
  };
};
// pzUH characters are big (400-900 px) side views: scaled down to ~104 px tall. 10 fps over 10 frames = one stride per second.
const pz = (pack, id, label, o) => ({ id, label, pack, fps: 10, scale: { height: 104 }, ...o });

// Kenney Jumper Pack: big flat-colour sprites, scaled down like the pzUH ones. Frame lists are file names without ".png".
const jumper = (dir, id, label, o) => ({
  id,
  label,
  pack: "kenney-jumper",
  fps: 6,
  scale: { height: 104 },
  ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((n) => `PNG/${dir}/${n}.png`)])),
});

const CHARACTERS = [
  pz("oga-knight", "knight", "Knight", {
    walk: p("png/", "Walk", range(1, 10)),
    idle: p("png/", "Idle", every(range(1, 10), 1)),
    jump: p("png/", "Jump", [5]),
    cheer: p("png/", "Jump", [3, 7]),
    attack: p("png/", "Attack", [1, 3, 5, 7, 9]),
    ko: p("png/", "Dead", [1, 4, 7, 10]),
  }),
  pz("oga-santa", "santa", "Santa", {
    walk: p("png/", "Walk", range(1, 13)),
    idle: p("png/", "Idle", every(range(1, 16), 2)),
    jump: p("png/", "Jump", [8]),
    cheer: p("png/", "Jump", [5, 11]),
  }),
  pz("oga-ninja", "ninja", "Ninja", {
    walk: u("png/", "Run", range(0, 9)),
    idle: u("png/", "Idle", range(0, 9)),
    jump: u("png/", "Jump", [5]),
    cheer: u("png/", "Jump", [3, 7]),
    attack: u("png/", "Attack", [0, 2, 4, 6, 8]),
    ko: u("png/", "Dead", [0, 3, 6, 9]),
  }),
  pz("oga-adventure-girl", "cowgirl", "Cowgirl", {
    walk: p("png/", "Run", range(1, 8)),
    idle: p("png/", "Idle", range(1, 10)),
    jump: p("png/", "Jump", [5]),
    cheer: p("png/", "Jump", [3, 7]),
    attack: p("png/", "Melee", range(1, 7)),
    ko: p("png/", "Dead", [1, 4, 7, 10]),
  }),
  pz("oga-temple-run", "cowboy", "Cowboy", {
    walk: u("", "Run", range(0, 9)),
    idle: u("", "Idle", range(0, 9)),
    jump: u("", "Jump", [5]),
    cheer: u("", "Jump", [3, 7]),
  }),
  pz("oga-cat-dog", "cat", "Cat", {
    walk: p("png/cat/", "Walk", range(1, 10)),
    idle: p("png/cat/", "Idle", range(1, 10)),
    jump: p("png/cat/", "Jump", [4]),
    cheer: p("png/cat/", "Jump", [2, 6]),
    ko: p("png/cat/", "Hurt", [4]),
  }),
  pz("oga-cat-dog", "dog", "Dog", {
    walk: p("png/dog/", "Walk", range(1, 10)),
    idle: p("png/dog/", "Idle", range(1, 10)),
    jump: p("png/dog/", "Jump", [4]),
    cheer: p("png/dog/", "Jump", [2, 6]),
    ko: p("png/dog/", "Hurt", [4]),
  }),
  pz("oga-dino", "dino", "Dino", {
    walk: p("png/", "Walk", range(1, 10)),
    idle: p("png/", "Idle", range(1, 10)),
    jump: p("png/", "Jump", [6]),
    cheer: p("png/", "Jump", [4, 8]),
    ko: p("png/", "Dead", [1, 3, 5, 8]),
  }),
  pz("oga-cute-girl", "cute-girl", "Cute Girl", {
    walk: p("png/", "Walk", every(range(1, 20), 2)),
    idle: p("png/", "Idle", every(range(1, 16), 2)),
    jump: p("png/", "Jump", [15]),
    cheer: p("png/", "Jump", [8, 22]),
    ko: p("png/", "Dead", [1, 10, 20, 30]),
  }),
  pz("oga-jack", "pumpkin", "Pumpkin", {
    walk: p("png/", "Walk", range(1, 10)),
    idle: p("png/", "Idle", range(1, 10)),
    jump: p("png/", "Jump", [5]),
    cheer: p("png/", "Jump", [3, 7]),
    ko: p("png/", "Dead", [1, 4, 7, 10]),
  }),
  pz("oga-ninja-girl", "ninja-girl", "Ninja Girl", {
    walk: u("png/", "Run", range(0, 9)),
    idle: u("png/", "Idle", range(0, 9)),
    jump: u("png/", "Jump", [5]),
    cheer: u("png/", "Jump", [3, 7]),
    attack: u("png/", "Attack", [0, 2, 4, 6, 8]),
    ko: u("png/", "Dead", [0, 3, 6, 9]),
  }),
  pz("oga-red-hat-boy", "red-hat-boy", "Red Hat Boy", {
    walk: p("png/", "Run", range(1, 8)),
    idle: p("png/", "Idle", range(1, 10)),
    jump: p("png/", "Jump", [6]),
    cheer: p("png/", "Jump", [4, 8]),
  }),
  pz("oga-flat-boy", "flat-boy", "Kid", {
    walk: p("png/", "Walk", every(range(1, 15), 2)),
    idle: p("png/", "Idle", every(range(1, 15), 2)),
    jump: p("png/", "Jump", [8]),
    cheer: p("png/", "Jump", [5, 11]),
  }),
  pz("oga-robot", "robot", "Gold Robot", {
    walk: p("png/", "Run", range(1, 8)),
    idle: p("png/", "Idle", range(1, 10)),
    jump: p("png/", "Jump", [5]),
    cheer: p("png/", "Jump", [3, 7]),
    attack: p("png/", "Melee", range(1, 8)),
    ko: p("png/", "Dead", [1, 4, 7, 10]),
  }),
  jumper("Players", "bunny-brown", "Brown Bunny", {
    walk: ["bunny1_walk1", "bunny1_walk2"],
    idle: ["bunny1_stand"],
    jump: ["bunny1_jump"],
    cheer: ["bunny1_ready", "bunny1_jump"],
    ko: ["bunny1_hurt"],
  }),
  jumper("Players", "bunny-purple", "Purple Bunny", {
    walk: ["bunny2_walk1", "bunny2_walk2"],
    idle: ["bunny2_stand"],
    jump: ["bunny2_jump"],
    cheer: ["bunny2_ready", "bunny2_jump"],
    ko: ["bunny2_hurt"],
  }),
  jumper("Enemies", "spike-man", "Spike Man", {
    walk: ["spikeMan_walk1", "spikeMan_walk2"],
    idle: ["spikeMan_stand"],
    jump: ["spikeMan_jump"],
    cheer: ["spikeMan_stand", "spikeMan_jump"],
  }),
  jumper("Enemies", "fly-man", "Propeller", {
    walk: ["flyMan_fly", "flyMan_still_fly"],
    idle: ["flyMan_stand"],
    jump: ["flyMan_jump"],
    cheer: ["flyMan_stand", "flyMan_jump"],
  }),
  {
    ...jumper("Enemies", "wing-man", "Wing Bird", {
      walk: ["wingMan1", "wingMan2", "wingMan3", "wingMan4", "wingMan5", "wingMan4", "wingMan3", "wingMan2"],
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
  {
    id: "npp-frog",
    label: "Frog",
    pack: "kenney-new-platformer",
    fps: 4,
    scale: { smooth: 2 },
    walk: ["Sprites/Enemies/Default/frog_idle.png", "Sprites/Enemies/Default/frog_jump.png"],
    idle: ["Sprites/Enemies/Default/frog_rest.png"],
    jump: ["Sprites/Enemies/Default/frog_jump.png"],
    cheer: ["Sprites/Enemies/Default/frog_rest.png", "Sprites/Enemies/Default/frog_jump.png"],
  },
  pixel("0000", "0001", "pixel-green", "Pixel Green"),
  pixel("0002", "0003", "pixel-blue", "Pixel Blue"),
  pixel("0004", "0005", "pixel-pink", "Pixel Pink"),
  pixel("0006", "0007", "pixel-yellow", "Pixel Yellow"),
  pixel("0009", "0010", "pixel-diver", "Pixel Diver"),
  pixel("0011", "0012", "pixel-block", "Angry Block"),
  pixel("0015", "0016", "pixel-spike", "Spike Helmet"),
  pixel("0021", "0022", "pixel-bot", "Pixel Robot"),
  {
    ...pixel("0024", "0025", "pixel-bat", "Pixel Bat"),
    walk: ["0024", "0025", "0026", "0025"].map((t) => `Tiles/Characters/tile_${t}.png`),
  },
  blob("Blue", "blob-blue", "Blue Blob"),
  blob("Green", "blob-green", "Green Blob"),
  blob("Red", "blob-red", "Red Blob"),
  {
    id: "turtle",
    label: "Turtle",
    pack: "oga-turtle",
    fps: 6,
    scale: { pixel: 4 },
    walk: ["tile 0", "tile 1", "tile 2", "tile 3"],
    idle: ["tile 0"],
    jump: ["tile 1"],
    cheer: ["tile 0", "tile 2"],
    head: { top: 0, left: 0.73, right: 0.98 }, // the head pokes out on the right; the top of the figure is shell
  },
];

// ---------------------------------------------------------------- helpers
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const archivePath = (pack) => path.join(srcDir, PACKS[pack].file);

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

const archives = new Map();
function archive(pack) {
  if (!archives.has(pack)) {
    const file = archivePath(pack);
    if (!fs.existsSync(file)) throw new Error("missing " + file + " (run with --download)");
    const buf = fs.readFileSync(file);
    const want = PACKS[pack].sha256;
    if (want && sha256(buf) !== want)
      throw new Error(PACKS[pack].file + " sha256 " + sha256(buf) + " does not match the pinned " + want);
    if (PACKS[pack].sheet) {
      const { w, h } = PACKS[pack].sheet,
        img = decodePng(buf);
      archives.set(pack, {
        tile: (n) => crop(img, { x: (n % (img.width / w)) * w, y: Math.floor(n / (img.width / w)) * h, w, h }),
      });
    } else archives.set(pack, readZip(buf));
  }
  return archives.get(pack);
}

function loadFrame(pack, name) {
  const tile = /^tile (\d+)$/.exec(name);
  const img = tile && PACKS[pack].sheet ? archive(pack).tile(Number(tile[1])) : decodePng(archive(pack).read(name));
  const box = alphaBounds(img);
  if (!box) throw new Error(pack + ": " + name + " is empty");
  return { name, canvas: { w: img.width, h: img.height }, box, img };
}

// ---------------------------------------------------------------- atlas
function buildCharacter(c) {
  const order = []; // unique source files, in atlas order
  for (const r of ["walk", "idle", "jump", "attack", "ko", "cheer"])
    for (const f of c[r] || []) if (!order.includes(f)) order.push(f);
  const frames = new Map(order.map((f) => [f, loadFrame(c.pack, f)]));
  const base = [...c.walk, ...c.idle].map((f) => frames.get(f));
  // Walk and idle frames that share a canvas keep the body on one column (no sway); other frames centre on their own bounds.
  const sameCanvas = base.every((f) => f.canvas.w === base[0].canvas.w && f.canvas.h === base[0].canvas.h);
  const cx = sameCanvas
    ? (Math.min(...base.map((f) => f.box.x)) + Math.max(...base.map((f) => f.box.x + f.box.w))) / 2
    : 0;
  const anchored = (f) => sameCanvas && f.canvas.w === base[0].canvas.w && f.canvas.h === base[0].canvas.h;
  const left = (f) => (anchored(f) ? cx - f.box.x : f.box.w / 2),
    right = (f) => (anchored(f) ? f.box.x + f.box.w - cx : f.box.w / 2);

  let scale = 1,
    mode = "area";
  if (c.scale.pixel) {
    scale = c.scale.pixel;
    mode = "pixel";
  } else if (c.scale.smooth) {
    scale = c.scale.smooth;
    mode = "smooth";
  } else if (c.scale.height) scale = c.scale.height / Math.max(...base.map((f) => f.box.h));
  const all = [...frames.values()];
  const dims = () => ({
    halfW: Math.ceil(Math.max(...all.map((f) => Math.max(left(f), right(f)))) * scale),
    h: Math.ceil(Math.max(...all.map((f) => f.box.h)) * scale),
  });
  let d = dims();
  if (mode === "area")
    while (d.halfW * 2 > MAX_FRAME || d.h > MAX_FRAME) {
      scale *= 0.98;
      d = dims();
    }
  const cw = d.halfW * 2,
    ch = d.h;
  if (cw > MAX_FRAME || ch > MAX_FRAME) throw new Error(c.id + ": cell " + cw + "x" + ch + " exceeds " + MAX_FRAME);

  const cells = new Map();
  const atlas = blank(cw * order.length, ch);
  order.forEach((name, i) => {
    const f = frames.get(name);
    let img = crop(f.img, f.box);
    if (mode === "pixel") img = resizeNearest(img, scale);
    else if (mode === "smooth") img = resizeBilinear(img, scale);
    else if (scale !== 1)
      img = resizeArea(img, Math.max(1, Math.round(f.box.w * scale)), Math.max(1, Math.round(f.box.h * scale)));
    const dx = anchored(f) ? d.halfW - Math.round(left(f) * scale) : Math.floor((cw - img.width) / 2);
    blit(atlas, img, i * cw + Math.max(0, Math.min(cw - img.width, dx)), ch - img.height);
    cells.set(name, { x: i * cw, y: 0, w: cw, h: ch });
  });
  const rects = (list) => list.map((f) => ({ ...cells.get(f) }));
  const animations = { idle: rects(c.idle) };
  animations.walk = rects(c.walk);
  animations.jump = rects(c.jump);
  animations.cheer = rects(c.cheer);
  if (c.attack) animations.attack = rects(c.attack);
  if (c.ko) animations.ko = rects(c.ko);
  const entry = {
    id: c.id,
    label: c.label,
    url: "/assets/" + c.id + ".png",
    frames: rects(c.walk),
    fps: c.fps,
    animations,
    anchor: { x: 0.5, y: 1 },
    license: "CC0-1.0",
    source: PACKS[c.pack].source,
  };
  if (c.head) entry.head = c.head; // where hats go (public/hats.js), when it isn't the top of the figure
  if (!c.attack) entry.combatFallback = "effects";
  return { entry, png: encodePng(atlas), cell: cw + " x " + ch, frames: order.length };
}

// ---------------------------------------------------------------- main
if (args.has("--download")) await download();
if (args.has("--check")) {
  for (const [name, pack] of Object.entries(PACKS)) {
    const file = archivePath(name);
    console.log(
      (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : "missing".padEnd(64)) +
        "  " +
        pack.file +
        (pack.sha256
          ? fs.existsSync(file) && sha256(fs.readFileSync(file)) === pack.sha256
            ? "  ok"
            : "  MISMATCH"
          : "  (not pinned)"),
    );
  }
  process.exit(0);
}

const seen = new Set();
for (const c of CHARACTERS) {
  if (seen.has(c.id)) throw new Error("duplicate id " + c.id);
  seen.add(c.id);
}
const existing = JSON.parse(fs.readFileSync(catalogFile, "utf8")).filter((e) => !seen.has(e.id));
const built = [];
for (const c of CHARACTERS) {
  const r = buildCharacter(c);
  fs.writeFileSync(path.join(outDir, c.id + ".png"), r.png);
  built.push(r.entry);
  console.log(
    c.id.padEnd(16) +
      c.label.padEnd(18) +
      ("cell " + r.cell).padEnd(14) +
      (r.frames + " frames").padEnd(11) +
      Math.round(r.png.length / 1024) +
      " KB",
  );
}
fs.writeFileSync(catalogFile, JSON.stringify([...existing, ...built], null, 2) + "\n");

for (const name of new Set(CHARACTERS.map((c) => c.pack))) {
  const lic = PACKS[name].license;
  if (!lic) continue;
  const text = archive(name).read(lic.entry);
  const target = path.join(outDir, lic.out);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(text)) fs.writeFileSync(target, text);
}
if (!fs.existsSync(path.join(outDir, "OGA_PZUH_LICENSE.txt")))
  console.warn("warning: public/assets/OGA_PZUH_LICENSE.txt is missing");
console.log(
  "\n" + built.length + " characters written; catalog now has " + (existing.length + built.length) + " entries.",
);
