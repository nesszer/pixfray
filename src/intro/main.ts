// PixFray intro page. One fixed WebGL stage; the scroll position becomes a chapter coordinate C (0..5) that drives
// the camera along a spline and every scene beat (fighters assembling, the duel, the ladder, coins, the OBS frame).
// Text lives in normal DOM sections over the stage, so the page reads without the 3D.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import {
  $,
  reduced,
  small,
  clamp01,
  ease,
  easeOut,
  range,
  esc,
  setProgress,
  finishLoading,
  loadBoard,
  sound,
  setSound,
  sections,
  measure,
  scrollC,
  centerChapter,
  setChapter,
} from "./page.ts";
import { filmPass } from "./film.ts";
import { loadImage, sampleSprite, VoxelFighter } from "./voxels.ts";
import {
  buildSky,
  buildIsland,
  buildLanterns,
  buildEmbers,
  buildIslets,
  buildDie,
  FACE_UP,
  buildPodium,
  buildCoins,
  buildClouds,
  buildChest,
  buildHoard,
  buildFrame,
  bakeNightEnv,
  addNightLights,
  lightShaft,
} from "./world.ts";
import type { DieValue } from "./world.ts";
import type { SpriteFrame, VoxelOptions } from "./voxels.ts";

type Vec2 = [number, number];
type Vec3 = [number, number, number];
// a /assets/characters.json entry, as far as this page reads it
type Character = { id: string; url: string; frames: SpriteFrame[]; animations?: { idle?: SpriteFrame[] } };
type Tag = {
  el: HTMLDivElement;
  inner: HTMLElement;
  on: boolean;
  html?: string;
  w?: number;
  corner?: boolean;
  call?: boolean;
  set(html: string): void;
};
type Box = { x0: number; y0: number; x1: number; y1: number };
type FBox = [number, number, number, number, number, number]; // x0, x1, y0, y1, z0, z1
type LockInfo = { key: string; title: string; sub: string; pos: string };
type LockTarget = LockInfo & { boxes: FBox[] };
type Roll = { at: number; v: DieValue; by: "a" | "b"; text: string };

let bornAt = 1e9; // the hero assembles once the loader lifts, so the first thing people see is the knight forming

const canvas = $<HTMLCanvasElement>("#stage");
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  if (!renderer.capabilities.isWebGL2) throw new Error("webgl2");
} catch {
  document.body.classList.add("no-webgl", "no-motion");
  measure();
  setChapter(0);
  addEventListener("scroll", () => setChapter(Math.round(scrollC())), { passive: true });
  loadBoard().then(() => finishLoading());
  throw new Error("PixFray intro: WebGL2 is not available; showing the text only.");
}

// render size: the screen's pixel ratio, but never more than a 1440p screen's worth of pixels, and a step lower each time
// frames run slow (a big or high-DPI screen, a weaker GPU), so the camera keeps gliding instead of stepping
const DPR = Math.min(devicePixelRatio || 1, small ? 1.5 : 2),
  PIXEL_BUDGET = 2560 * 1440;
const QUALITY = [1, 1, 0.8, 0.65, 0.5]; // render scale per step; ambient occlusion only at step 0
let quality = 0;
// in range: govern() stops at the last QUALITY step
const pixelRatio = () => Math.min(DPR, Math.sqrt(PIXEL_BUDGET / (innerWidth * innerHeight))) * QUALITY[quality]!;
renderer.setPixelRatio(pixelRatio());
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = !small;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene() as THREE.Scene & { fog: THREE.FogExp2 }; // fog is set to a FogExp2 below and never replaced
scene.fog = new THREE.FogExp2(0x0d0906, small ? 0.022 : 0.027);
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 200);

const sky = buildSky();
scene.add(sky);
bakeNightEnv(renderer, scene);
const { hemi, cool, key, rim, warm } = addNightLights(scene, {
  hemi: 0.5,
  cool: 0.5,
  key: 1.5,
  rim: 0.9,
  shadowMap: 2048,
  shadowBox: { left: -5, right: 5, top: 5, bottom: -5 },
});
key.castShadow = !small;
const clash = new THREE.PointLight(0xffc070, 0, 4, 2);
scene.add(clash); // the flash between the fighters on a hit

const island = buildIsland({ shadows: !small }),
  lanterns = buildLanterns(),
  embers = buildEmbers(small ? 380 : 900),
  islets = buildIslets(),
  die = buildDie(),
  podium = buildPodium(),
  coins = buildCoins(),
  clouds = buildClouds(),
  chest = buildChest();
die.visible = false;
chest.group.position.set(-1.75, 0, 1.25);
chest.group.rotation.y = 0.62;
scene.add(island, lanterns.group, embers, islets.group, die, podium.mesh, coins.mesh, clouds.group, chest.group);
// the chest's light lives in the scene (dark until the lid opens): a light that comes and goes with the chest changes the
// light count, and that rebuilds every lit material at once, a multi-second freeze the first time the loot chapter shows
chest.group.updateMatrixWorld(true);
scene.attach(chest.light);
chest.group.visible = false;
const hoard = buildHoard();
hoard.mesh.position.set(0, 0, 0.2);
hoard.mesh.visible = false;
scene.add(hoard.mesh);
const frame3d = buildFrame();
frame3d.group.position.set(0, -0.7, 0);
frame3d.group.visible = false;
scene.add(frame3d.group);
const FOG = small ? 0.8 : 1;

// post: bloom for the lanterns and embers, then a film pass (vignette and fine grain)
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: small ? 0 : 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
// ambient occlusion on larger screens: contact shadows under feet and in the gaps between cubes
const gtao = small ? null : new GTAOPass(scene, camera, 512, 512);
if (gtao) {
  gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1, scale: 1.1, samples: 16 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
}
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.62, 0.55, 0.78);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const film = filmPass();
composer.addPass(film);

// HTML tags pinned to 3D points
const tagLayer = $("#tags");
const proj = new THREE.Vector3();
function makeTag(cls: string, html: string): Tag {
  const el = document.createElement("div");
  el.className = "tag";
  el.innerHTML = `<div class="${cls}">${html}</div>`;
  tagLayer.appendChild(el);
  return {
    el,
    inner: el.firstChild as HTMLElement, // the div written just above
    on: false,
    set(html: string) {
      if (this.html !== html) {
        this.inner.innerHTML = html;
        this.html = html;
      }
    },
  };
}
function placeTag(tag: Tag, pos: THREE.Vector3, visible: boolean) {
  if (visible) {
    proj.copy(pos).project(camera);
    const lim = tag.corner ? 0.985 : 0.9; // frame-corner labels are anchored by their own edge, so they may sit near the screen edge
    if (proj.z > 1 || Math.abs(proj.x) > lim || Math.abs(proj.y) > 0.9 || ((1 - proj.y) / 2) * innerHeight < 84)
      visible = false; // never under the header
    else {
      let x = ((proj.x + 1) / 2) * innerWidth;
      if (!tag.call && !tag.corner) {
        const hw = (tag.w ||= tag.inner.offsetWidth) / 2 + 8;
        x = Math.min(innerWidth - hw, Math.max(hw, x));
      }
      // plain labels grow upward from their point, so one near the top is held down clear of the header's links
      const y = ((1 - proj.y) / 2) * innerHeight,
        top = tag.call || tag.corner ? 0 : 136;
      tag.el.style.transform = `translate3d(${x.toFixed(1)}px, ${Math.max(top, y).toFixed(1)}px, 0)`;
    }
  }
  if (visible !== tag.on) {
    tag.on = visible;
    tag.el.classList.toggle("on", visible);
  }
}
// lock-on bracket: four corner marks that glide from subject to subject, with a two-line readout
const lockEl = document.createElement("div");
lockEl.className = "lock";
lockEl.innerHTML = '<i></i><i></i><i></i><i></i><div class="lock-txt"><b></b><span></span></div>';
tagLayer.appendChild(lockEl);
// the elements written just above
const lockTxt = lockEl.lastChild as HTMLElement,
  lockTitle = lockEl.querySelector("b") as HTMLElement,
  lockSub = lockEl.querySelector(".lock-txt span") as HTMLElement;
let lockR: Box | null = null,
  lockKey: string | null = null,
  lockShown = false,
  lockPos: string | null = null;
const lockP = new THREE.Vector3(),
  lockBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
function boxRect(boxes: FBox[], out: Box) {
  out.x0 = out.y0 = Infinity;
  out.x1 = out.y1 = -Infinity;
  for (const [x0, x1, y0, y1, z0, z1] of boxes)
    for (let k = 0; k < 8; k++) {
      lockP.set(k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? z1 : z0).project(camera);
      if (lockP.z > 1) return false;
      const sx = ((lockP.x + 1) / 2) * innerWidth,
        sy = ((1 - lockP.y) / 2) * innerHeight;
      out.x0 = Math.min(out.x0, sx);
      out.x1 = Math.max(out.x1, sx);
      out.y0 = Math.min(out.y0, sy);
      out.y1 = Math.max(out.y1, sy);
    }
  return true;
}
const fbox = (f: VoxelFighter, pad = 0.25): FBox => {
  const p = f.group.position;
  return [p.x - f.width / 2, p.x + f.width / 2, p.y, p.y + f.height, p.z - pad, p.z + pad];
};
function placeLock(target: LockTarget | null, alpha: number, dt: number, portrait: boolean) {
  const ok = target !== null && alpha > 0.01 && boxRect(target.boxes, lockBox);
  if (ok !== lockShown) {
    lockShown = ok;
    lockEl.classList.toggle("on", ok);
  }
  if (ok) {
    const b = lockBox,
      pad = 12,
      m = 10;
    b.x0 = Math.max(m, b.x0 - pad);
    b.x1 = Math.min(innerWidth - m, b.x1 + pad);
    b.y0 = Math.max(m + 64, b.y0 - pad);
    b.y1 = Math.min(innerHeight - m, b.y1 + pad);
    if (!lockR) lockR = { ...b };
    else {
      const k = reduced ? 1 : 1 - Math.exp(-dt * 7);
      for (const n of ["x0", "y0", "x1", "y1"] satisfies (keyof Box)[]) lockR[n] += (b[n] - lockR[n]) * k;
    }
    if (lockKey !== target.key) {
      lockKey = target.key;
      lockTitle.textContent = target.title;
      lockSub.textContent = target.sub;
    }
    const r = lockR,
      st = lockEl.style;
    st.transform = `translate3d(${r.x0.toFixed(1)}px, ${r.y0.toFixed(1)}px, 0)`;
    st.width = `${(r.x1 - r.x0).toFixed(1)}px`;
    st.height = `${(r.y1 - r.y0).toFixed(1)}px`;
    st.opacity = alpha.toFixed(3);
    let pos = portrait ? "none" : target.pos; // on a phone the corners alone; the copy below carries the numbers
    if (pos === "below" && r.y1 + 64 > innerHeight) pos = "above";
    if (pos !== lockPos) {
      lockPos = pos;
      lockTxt.className = `lock-txt ${pos}`;
    }
  }
}
const scrimL = document.createElement("div"),
  scrimR = document.createElement("div");
scrimL.className = "scrim scrim-l";
scrimR.className = "scrim scrim-r";
document.body.insertBefore(scrimL, tagLayer);
document.body.insertBefore(scrimR, tagLayer);

const tasks: Promise<unknown>[] = [];
let done = 0;
const track = <T>(p: Promise<T>) => {
  tasks.push(p);
  p.finally(() => {
    done++;
    setProgress(0.08 + (0.84 * done) / tasks.length);
  });
  return p;
};
setProgress(0.04);

const boardP = track(loadBoard());
const catalogP = track(fetch("/assets/characters.json").then((r): Promise<Character[]> => r.json()));
track(document.fonts?.load("650 40px Fraunces") ?? Promise.resolve());

const catalog = await catalogP.catch(() => []);
const byId = new Map<string, Character>(catalog.map((c) => [c.id, c]));
const rows = await boardP;
const wanted = [...new Set(["knight", "toon-ranger", ...rows.map((p) => p.avatar)])].filter((id) => byId.has(id));
const images = new Map<string, HTMLImageElement>();
await Promise.all(
  wanted.map((id) =>
    track(
      loadImage(byId.get(id)!.url) // wanted holds only ids in byId
        .then((img) => images.set(id, img))
        .catch(() => {}),
    ),
  ),
);

function fighter(id: string, height: number, opts: VoxelOptions, density = 15) {
  const c = byId.get(id),
    img = images.get(id);
  if (!c || !img) return null;
  const frame = c.animations?.idle?.[0] || c.frames[0]!; // every catalog character has a frame
  const targetRows = Math.round(height * (small ? density * 0.75 : density));
  const step = Math.max(2, Math.round(frame.h / targetRows));
  const sprite = sampleSprite(img, frame, step);
  const f = new VoxelFighter(sprite, { size: height / sprite.rows, ...opts });
  scene.add(f.group);
  return f;
}
const hero = fighter("knight", 2.3, { scatter: "burst", seed: 3, shadows: !small, layers: 8 }, 23);
const rival = fighter("toon-ranger", 2.15, { scatter: "burst", seed: 7, shadows: !small, layers: 8 }, 23);
if (rival) rival.group.scale.x = -1;
const crowd = rows.flatMap((person, i) => {
  const f = fighter(person.avatar, 1.35, { scatter: "rain", seed: 11 + i, shadows: !small, layers: 6 });
  return f ? [{ person, f }] : [];
});

// per rank: where the crowd stands, where it steps back to the ropes for the duel, its podium tower's x and levels (rank 1
// in the middle and tallest, 2 left, 3 right, 4 and 5 outside; the Elo itself is on the tag)
const RANKS = [
  { spot: [-2.8, -1.0], duel: [-4.3, -1.9], x: 0, levels: 16 },
  { spot: [-1.9, -2.3], duel: [-3.3, -3.5], x: -1.25, levels: 12 },
  { spot: [0.2, -3.1], duel: [-5.6, -5.4], x: 1.25, levels: 10 },
  { spot: [1.9, -2.3], duel: [-5.3, -3.6], x: -2.5, levels: 8 },
  { spot: [2.8, -1.0], duel: [-2.1, -4.9], x: 2.5, levels: 7 },
] satisfies { spot: Vec2; duel: Vec2; x: number; levels: number }[];
const PODIUM_Z = -2.05,
  DUEL_X = 1.0;
// a column of light over the rank 1 tower
const beam = lightShaft(
  new THREE.CylinderGeometry(0.42, 0.62, 16, 20, 1, true),
  "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
  `uniform float uA, uTime; varying vec2 vUv;
    void main(){ float band = 0.75 + 0.25 * step(0.5, fract(vUv.y * 22.0 - uTime * 0.8));
      float a = uA * sqrt(sqrt(max(1.0 - vUv.y, 0.0))) * (1.0 - smoothstep(0.85, 1.0, vUv.y)) * band * 0.32;
      gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a, a); }`,
);
beam.visible = false;
scene.add(beam);

const T = {
  lookReply: makeTag(
    "tag-line tag-log",
    `<span><b style="color:#c9a45c">you</b> !look</span><span><b style="color:#e7c27c">PixFray</b> @you, change your look here: ${location.host}/?channel=yourchannel#fighter</span>`,
  ),
  challenge: makeTag("tag-line", '<b style="color:#c9a45c">challenger</b> !challenge @rival'),
  fight: makeTag("tag-line", '<b style="color:#7fa7d9">rival</b> !fight'),
  roll: makeTag("tag-roll", ""),
  hpA: makeTag("tag-hp", 'Challenger · 100 HP<span class="bar"><i style="width:100%"></i></span>'),
  hpB: makeTag("tag-hp", ""),
  // a callout: a dot on the 3D point, a leader line, then a title and one line of detail
  loss: makeTag(
    "tag-call ",
    '<i class="dot"></i><i class="lead"></i><span class="txt"><b>+$3 a loss</b><span>every finished duel pays</span></span>',
  ),
  jump: makeTag("tag-jump", "!jump"),
  obsL: makeTag("tag-obs", "<b>OBS browser source</b> overlay link · 1920 × 1080"),
};
T.obsL.corner = T.loss.call = true;
const FIGHTERS = catalog.length || 56,
  top1 = crowd[0]?.person;
const LOCKS = [
  {
    key: "knight",
    title: "Knight",
    sub: `${hero ? hero.count.toLocaleString("en-US") + " cubes · " : ""}1 of ${FIGHTERS} fighters`,
    pos: "below",
  },
  { key: "you", title: "@you", sub: "walks onto the stream when you chat", pos: "below" },
  { key: "duel", title: "", sub: "", pos: "none" },
  {
    key: "top",
    title: top1 ? `1. ${top1.username}` : "Top of the ladder",
    sub: top1 ? `${top1.elo} Elo · ${top1.wins}–${top1.losses}` : "example ladder",
    pos: "above",
  },
  { key: "loot", title: "+$5 a win", sub: "+$3 a loss · plus an upgrade point", pos: "left" },
] satisfies [LockInfo, LockInfo, LockInfo, LockInfo, LockInfo];
const names = crowd.map((c) =>
  makeTag("tag-line", `<b style="color:${esc(c.person.color)}">${esc(c.person.username)}</b>`),
);
const ranks = crowd.map((c, i) => makeTag("tag-rank", `<b>${c.person.elo}</b>${i + 1}. ${esc(c.person.username)}`));

// one entry per chapter: ember arena, teal dusk for chat, crimson duel, cold moonlit ladder, gold loot, blue night stream
const hex = (...l: number[]) => l.map((h) => new THREE.Color(h));
const rgb = (...l: number[]) => Array.from({ length: l.length / 3 }, (_, k) => new THREE.Color().fromArray(l, k * 3));
const xyz = (...l: number[]) => rgb(...l).map((c) => new THREE.Vector3(c.r, c.g, c.b));
const MOOD = {
  fog: hex(0x0d0906, 0x061110, 0x120506, 0x050a16, 0x0e0802, 0x070913),
  cloud: hex(0x4a3020, 0x1f4846, 0x4a1a16, 0x2c3c66, 0x4a3010, 0x2a3560),
  hemi: hex(0x8a6a4a, 0x3f7a76, 0x7a4038, 0x45578a, 0x8a6a34, 0x6a7090),
  key: hex(0xffcf96, 0xffd7a8, 0xffa27a, 0x9fb8ff, 0xfff0d0, 0xffd9a8),
  cool: hex(0x5d7cff, 0x46d0c4, 0x7c66ff, 0x7090ff, 0x5d7cff, 0x6a86ff),
  warm: hex(0xff9a40, 0xff9a40, 0xff6a34, 0xffa850, 0xffb040, 0xffa040),
  ring: hex(0xff7a26, 0x2fd0c0, 0xff3020, 0x6c9cff, 0xffb030, 0xff8a36),
  // three numbers per chapter
  floor: rgb(1, 1, 1, 0.72, 0.92, 0.98, 1.08, 0.78, 0.74, 0.7, 0.8, 1.08, 1.1, 0.98, 0.8, 0.86, 0.88, 1.0),
  sky: xyz(1, 1, 1, 0.5, 1.15, 1.25, 1.45, 0.6, 0.55, 0.45, 0.75, 1.7, 1.3, 1.0, 0.4, 0.6, 0.7, 1.35),
  lift: xyz(0, 0, 0, 0, 0.024, 0.032, 0.014, 0, 0.004, 0, 0.004, 0.022, 0.012, 0.008, 0.002, 0, 0.004, 0.018),
  gain: xyz(1, 1, 1, 0.8, 1.04, 1.14, 1.03, 0.97, 0.95, 0.9, 0.98, 1.12, 1.1, 1.05, 0.94, 0.9, 0.97, 1.12),
  fogD: [0.027, 0.025, 0.027, 0.024, 0.03, 0.011],
  keyI: [1.8, 1.5, 1.95, 1.45, 2.3, 1.9],
  coolI: [0.8, 1.3, 0.6, 1.7, 0.35, 1.1],
  warmI: [1, 0.95, 1.05, 0.55, 1.3, 1.35],
  moon: [1, 1, 0, 1, 0.4, 1],
  rim: [1.5, 0.9, 0.25, 1.4, 0.5, 1.8],
  bloom: [0.62, 0.62, 0.62, 0.62, 0.42, 0.62],
  side: [1, 1, -1, 1, -1, 0.95], // which way the picture slides from the copy: +1 right, -1 left
};
// sets the chapter mood for C (warm lights flicker with t) and returns MOOD.side
function applyMood(C: number, t: number) {
  // in range (l[i]!, l[i + 1]!): i <= 4 and every MOOD list has 6 entries
  const i = Math.min(4, Math.floor(C)),
    f = ease(clamp01(C - i));
  const n = (l: number[]) => l[i]! + (l[i + 1]! - l[i]!) * f;
  const col = (out: THREE.Color, l: THREE.Color[]) => out.lerpColors(l[i]!, l[i + 1]!, f);
  const vec = (out: THREE.Vector3, l: THREE.Vector3[]) => out.lerpVectors(l[i]!, l[i + 1]!, f);
  col(scene.fog.color, MOOD.fog);
  scene.fog.density = n(MOOD.fogD) * FOG;
  for (const m of clouds.mats) {
    m.uniforms.uDeep.value.copy(scene.fog.color);
    col(m.uniforms.uLit.value, MOOD.cloud);
  }
  col(hemi.color, MOOD.hemi);
  col(key.color, MOOD.key);
  key.intensity = n(MOOD.keyI);
  col(cool.color, MOOD.cool);
  cool.intensity = n(MOOD.coolI);
  warm.forEach((l, k) => {
    col(l.color, MOOD.warm);
    l.intensity = n(MOOD.warmI) * 16 + (reduced ? 0 : Math.sin(t * 7 + k * 2) * 1.5 + Math.sin(t * 17 + k) * 0.8);
  });
  sky.material.uniforms.uMoon.value = n(MOOD.moon);
  rim.intensity = n(MOOD.rim);
  col(island.userData.floor.value, MOOD.floor);
  col(island.userData.rune.uColor.value, MOOD.ring);
  col(lanterns.cone.uniforms.uColor.value, MOOD.warm);
  vec(sky.material.uniforms.uMul.value, MOOD.sky);
  vec(film.uniforms.uLift.value, MOOD.lift);
  vec(film.uniforms.uGain.value, MOOD.gain);
  bloom.strength = n(MOOD.bloom);
  return n(MOOD.side);
}

// each key looks at its subject; setViewOffset then slides the picture away from the copy (MOOD.side)
const KEYS = [
  { pos: [0.9, 1.15, 6.1], look: [0, 1.4, 0] },
  { pos: [0.8, 7.4, 6.9], look: [0, 0.5, -1.0] },
  { pos: [0.05, 1.3, 7.8], look: [-0.25, 1.6, 0] },
  { pos: [0.4, 1.0, 7.6], look: [0, 3.7, -2.05] },
  { pos: [2.6, 2.2, 5.6], look: [-0.5, 1.75, 0.1] },
  { pos: [-3.2, 3.0, 28.6], look: [0, -0.5, 0] },
] satisfies { pos: Vec3; look: Vec3 }[];
const curve = (pick: (k: (typeof KEYS)[number]) => Vec3) =>
  new THREE.CatmullRomCurve3(
    KEYS.map((k) => new THREE.Vector3(...pick(k))),
    false,
    "centripetal",
  );
const posCurve = curve((k) => k.pos),
  lookCurve = curve((k) => k.look);
const camPos = new THREE.Vector3(),
  camLook = new THREE.Vector3(),
  tmp = new THREE.Vector3(),
  right = new THREE.Vector3(),
  up = new THREE.Vector3();
function cameraAt(C: number, portrait: boolean) {
  const u = C / 5;
  posCurve.getPoint(u, camPos);
  lookCurve.getPoint(u, camLook);
  if (portrait) {
    // narrow screens: step back; the view offset lifts the scene above the text
    tmp.copy(camPos).sub(camLook);
    camPos
      .copy(camLook)
      .addScaledVector(
        tmp,
        1.12 +
          0.2 * clamp01(1 - Math.abs(C - 2)) +
          0.75 * clamp01(1 - Math.abs(C - 3)) -
          0.05 * clamp01((C - 3.5) * 2) +
          0.6 * clamp01((C - 4.3) / 0.7),
      );
    camPos.y = Math.max(camPos.y, 0.9); // stepping back from an upward look must not sink the camera under the floor
    camLook.y += 0.9 * clamp01(1 - Math.abs(C - 3) * 1.5);
    camLook.y += 0.8 * clamp01(1 - Math.abs(C - 4) * 1.5); // the hero stands on the hoard
  }
}

// the copy and the bottom bar are fixed to the screen; the site footer pushes them up as it scrolls in, instead of covering them
const foot = document.querySelector(".site-foot");
let footPx = -1;
function footLift() {
  const px = foot ? Math.max(0, Math.round(innerHeight - foot.getBoundingClientRect().top)) : 0;
  if (px !== footPx) {
    footPx = px;
    document.body.style.setProperty("--foot-lift", px + "px");
  }
}
addEventListener("scroll", footLift, { passive: true });
addEventListener("resize", footLift);
footLift();

const pointer = new THREE.Vector2(0, 0),
  pointerSmooth = new THREE.Vector2(0, 0);
let pointerIn = false;
const ray = new THREE.Raycaster(),
  plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
  hit = new THREE.Vector3();
addEventListener(
  "pointermove",
  (e) => {
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    pointerIn = e.pointerType === "mouse";
  },
  { passive: true },
);
document.addEventListener("pointerleave", () => (pointerIn = false));
let overHero = false,
  jumpAt = -10;
function jump() {
  jumpAt = now;
  sound.jump();
}
addEventListener("click", (e) => {
  if (overHero && !(e.target as Element).closest("a, button, .copy")) jump(); // a click lands on an element
});
addEventListener("keydown", (e) => {
  if (e.key === "j" && !(e.target as Element).closest("input, textarea")) jump(); // a key event's target is the focused element or body
});

let C = 0,
  targetC = 0,
  vC = 0;
const CAM_W = 6.4;
const ROLLS = [
  { at: 0.22, v: 5, by: "a", text: "Challenger hits for 34" },
  { at: 0.5, v: 3, by: "b", text: "Rival misses" },
  { at: 0.78, v: 6, by: "a", text: "Challenger crits for 50" },
] satisfies Roll[];
let lastRoll = -1,
  rollAt = -10;
const timer = new THREE.Timer();
let now = 0;

function resize() {
  const w = innerWidth,
    h = innerHeight,
    pr = pixelRatio();
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w / 2, h / 2);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 50 : w / h < 1.2 ? 44 : 36;
  camera.updateProjectionMatrix();
  film.uniforms.uAspect.value = w / h;
  film.uniforms.uRes.value.set(w * pr, h * pr);
  embers.material.uniforms.uPx.value = (pr * h) / 900;
  measure();
  targetC = scrollC();
}
addEventListener("resize", resize);
addEventListener("scroll", () => (targetC = scrollC()), { passive: true });
// smooth wheel: a mouse wheel moves the page in hard notches, so ease the page toward where the wheel wants it instead.
// Keys, the scrollbar, touch and links keep the browser's own scrolling; any of them takes over from the wheel.
let wantY: number | null = null,
  curY = 0;
addEventListener(
  "wheel",
  (e) => {
    if (reduced || e.ctrlKey || e.defaultPrevented) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1,
      max = document.documentElement.scrollHeight - innerHeight;
    if (wantY === null) wantY = curY = scrollY;
    wantY = Math.max(0, Math.min(max, wantY + e.deltaY * unit));
    e.preventDefault();
  },
  { passive: false },
);
function glide(dt: number) {
  if (wantY === null) return;
  if (Math.abs(scrollY - curY) > 4) {
    wantY = null;
    return;
  } // something else moved the page
  curY += (wantY - curY) * (1 - Math.exp(-dt * 6));
  if (Math.abs(wantY - curY) < 0.5) curY = wantY;
  scrollTo(0, curY);
  if (curY === wantY) wantY = null;
}
resize();

const m4 = new THREE.Matrix4(),
  q = new THREE.Quaternion(),
  e3 = new THREE.Euler(),
  v = new THREE.Vector3(),
  s = new THREE.Vector3(1, 1, 1);
const heroHome = new THREE.Vector3();
let lastGold = -1,
  lastFrame = -1;

function frame() {
  const dt = Math.min(0.05, timer.getDelta()),
    t = (now = timer.getElapsed());
  glide(dt);
  // the camera follows the scroll on a critically damped spring: it speeds up and slows down smoothly, so a key press, a rail
  // link, a scrollbar drag or a touch fling doesn't jerk it from still to full speed in one frame. Same lag as a plain ease
  // while scrolling (2 / CAM_W s), and solved exactly, so a slow frame can't make it overshoot.
  if (reduced) {
    C = Math.round(targetC);
    vC = 0;
  } else {
    const x = C - targetC,
      k = vC + CAM_W * x,
      e = Math.exp(-CAM_W * dt);
    C = targetC + (x + k * dt) * e;
    vC = (vC - CAM_W * k * dt) * e;
    if (C < 0 || C > 5) {
      C = Math.max(0, Math.min(5, C));
      vC = 0;
    }
  }
  if (Math.abs(targetC - C) < 1e-4 && Math.abs(vC) < 1e-3) {
    C = targetC;
    vC = 0;
  }
  setChapter(C); // the copy follows the camera, so it changes when the scene does, not the moment the scroll crosses a line
  const portrait = innerWidth / innerHeight < 0.9;

  // camera with a little cursor parallax; the picture slides away from the copy
  cameraAt(C, portrait);
  // opening shot: the camera starts wide and pushes in while the knight's cubes fly together
  const born = clamp01((t - bornAt) / 2.8);
  if (!reduced && born < 1)
    camPos
      .sub(camLook)
      .multiplyScalar(1 + 0.45 * (1 - ease(born)))
      .add(camLook);
  const W = innerWidth,
    H = innerHeight,
    side = applyMood(C, t);
  if (portrait) camera.setViewOffset(W, H, 0, H * (0.26 + 0.07 * clamp01(1 - Math.abs(C - 3) * 1.5)), W, H); // the ladder's pillar bases clear its headline
  else camera.setViewOffset(W, H, -side * W * (0.17 + 0.018 * clamp01(1 - C * 2)), 0, W, H);
  scrimL.style.opacity = portrait ? "0" : clamp01(side).toFixed(3);
  scrimR.style.opacity = portrait ? "0" : clamp01(-side).toFixed(3);
  pointerSmooth.lerp(reduced ? pointerSmooth.set(0, 0) : pointer, 1 - Math.exp(-dt * 4));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  if (!reduced) {
    right.setFromMatrixColumn(camera.matrix, 0);
    up.setFromMatrixColumn(camera.matrix, 1);
    camera.position.addScaledVector(right, pointerSmooth.x * 0.28).addScaledVector(up, pointerSmooth.y * 0.16);
    camera.lookAt(camLook);
  }
  const rolled = ROLLS[lastRoll],
    hitAge = t - rollAt,
    hitByA = rolled?.by === "a",
    hitK = hitByA && hitAge < 0.6 ? (1 - hitAge / 0.6) * (rolled.v === 6 ? 1 : 0.45) : 0;
  if (hitK > 0 && !reduced)
    camera.position.add(tmp.set(Math.sin(t * 61) * 0.06, Math.sin(t * 47) * 0.05, 0).multiplyScalar(hitK));

  // hero: centre, steps left for the duel, breaks into cubes while the ladder shows, rebuilds at the centre for the loot
  const duelIn = ease(range(C, 1.35, 1.85)),
    back = C > 3;
  const heroX = back ? 0 : -DUEL_X * duelIn;
  const heroGone = range(C, 2.62, 2.85) - range(C, 3.35, 3.7);
  const gold = reduced ? (C > 3.5 && C < 4.5 ? 1 : 0) : ease(range(C, 3.4, 3.85)) * (1 - ease(range(C, 4.4, 4.75)));
  const lift = hoard.top * gold;
  const roll = range(C, 1.62, 2.55);
  const d = reduced && C >= 2 && C < 3 ? 1 : roll;
  let lunge = 0;
  if (hero) {
    heroHome.set(heroX, 0, back ? 0.2 : 0.15 * duelIn);
    const since = t - jumpAt,
      jumpY = since < 0.6 ? Math.sin((since / 0.6) * Math.PI) * 0.8 : 0;
    const lastA = ROLLS.filter((r) => r.by === "a" && d >= r.at).pop();
    if (lastA && t - rollAt < 0.35 && ROLLS[lastRoll] === lastA)
      lunge = Math.sin(((t - rollAt) / 0.35) * Math.PI) * 0.35;
    hero.group.position.set(heroHome.x + lunge, jumpY + lift, heroHome.z);
    hero.group.rotation.z = back ? 0 : -(0.07 * duelIn + lunge * 0.25); // leans into the swing
    if (!reduced) hero.group.scale.y = 1 + Math.sin(t * 2.1) * 0.008;
    // cursor push: intersect the pointer ray with the hero's plane, in hero-local units
    overHero = false;
    hero.pointer = null;
    if (pointerIn && C < 4.6) {
      ray.setFromCamera(pointer, camera);
      plane.constant = -hero.group.position.z;
      if (ray.ray.intersectPlane(plane, hit)) {
        const lx = hit.x - hero.group.position.x,
          ly = hit.y - hero.group.position.y;
        overHero = Math.abs(lx) < hero.width * 0.6 && ly > -0.2 && ly < hero.height * 1.08;
        if (overHero && !reduced) hero.pointer = { x: lx, y: ly };
      }
    }
    document.body.style.cursor = overHero ? "pointer" : "";
    hero.update(reduced ? (heroGone > 0.5 ? 0 : 1) : Math.min(range(t - bornAt, 0.15, 2.3), 1 - heroGone));
    placeTag(T.jump, v.set(hero.group.position.x, hero.group.position.y + hero.height + 0.35, 0), t - jumpAt < 0.9);
  }

  // crowd rains in during chapter 1, climbs the podium in chapter 3
  // both finish before the chapter settles at C = 3, so each fighter stands square on its tower instead of still sliding in
  const climb = ease(range(C, 2.62, 2.9)) * (1 - ease(range(C, 3.4, 3.75)));
  const grow = range(C, 2.6, 2.88) * (1 - range(C, 3.45, 3.8)),
    cell = podium.cell;
  let pi = 0;
  crowd.forEach((c, i) => {
    const a = Math.min(
      range(C, 0.3 + i * 0.07, 0.68 + i * 0.06),
      1 - range(C, 3.42 + i * 0.03, 3.68 + i * 0.03) + range(C, 4.4 + i * 0.05, 4.8 + i * 0.05),
    );
    // in range (here and below): crowd has at most 5 fighters, like RANKS, names and ranks
    const r = RANKS[i]!,
      sx = r.spot[0] + (r.duel[0] - r.spot[0]) * duelIn,
      sz = r.spot[1] + (r.duel[1] - r.spot[1]) * duelIn;
    const px = r.x,
      levels = Math.round(r.levels * grow),
      h = levels * cell;
    c.f.group.position.set(sx + (px - sx) * climb, h * climb, sz + (PODIUM_Z - sz) * climb);
    c.f.update(reduced ? (C >= 0.5 ? 1 : 0) : a);
    placeTag(
      names[i]!, // in range: as above
      v.set(c.f.group.position.x, c.f.group.position.y + c.f.height + 0.12, c.f.group.position.z),
      a > 0.92 && C < 1.45 && (!portrait || i % 2 === 0),
    );
    placeTag(
      ranks[i]!, // in range: as above
      v.set(px, h + c.f.height + 0.12, PODIUM_Z),
      C > 2.95 && C < 3.4 && !portrait && i > 0,
    );
    if (i === 0) {
      beam.visible = climb > 0.01;
      beam.position.set(px, h + 8, PODIUM_Z);
      beam.material.uniforms.uA.value = climb;
      beam.material.uniforms.uTime.value = t;
    }
    // podium column: 2x2 cubes per level, brass at the top
    for (let l = 0; l < levels; l++)
      for (let k = 0; k < 4; k++) {
        const top = l === levels - 1,
          rune = l % 4 === 2 && k === 3 - (i % 2);
        m4.makeTranslation(px + ((k & 1) - 0.5) * cell, (l + 0.5) * cell, PODIUM_Z + ((k >> 1) - 0.5) * cell);
        podium.mesh.setMatrixAt(pi, m4);
        podium.mesh.setColorAt(pi++, top ? COL_BRASS : rune ? COL_RUNE : (l + k) % 2 ? COL_STONE_A : COL_STONE_B);
      }
  });
  podium.mesh.count = pi;
  podium.mesh.instanceMatrix.needsUpdate = true;
  if (podium.mesh.instanceColor) podium.mesh.instanceColor.needsUpdate = true;

  if (rival) {
    const ra = range(C, 1.4, 1.8) * (1 - range(C, 2.62, 2.85));
    const shake = hitByA && hitAge < 0.5 ? Math.sin(t * 70) * 0.05 * (1 - hitAge / 0.5) : 0;
    rival.group.position.set(DUEL_X + shake, 0, 0.15);
    rival.group.rotation.z = 0.05 * ra - shake * 0.8; // braced, rocked back by a hit
    clash.position.set(0, 1.25, 0.6);
    clash.intensity = reduced ? 0 : hitK * 45;
    // damage shows: cubes break off the side facing the challenger, more with each hit
    const lost = lastRoll >= 0 ? (lastRoll >= 2 ? 84 : 34) : 0,
      hk = reduced ? lost / 100 : rival.hurt + (lost / 100 - rival.hurt) * (1 - Math.exp(-dt * 6));
    rival.hurt = Math.abs(hk - lost / 100) < 0.004 ? lost / 100 : hk;
    rival.hurtAt.x = rival.width * 0.3;
    rival.hurtAt.y = rival.height * 0.55;
    rival.update(reduced ? (ra > 0.5 ? 1 : 0) : ra);
  }
  // which roll has landed (scroll can run backwards)
  const landed = ROLLS.findLastIndex((r) => d >= r.at);
  if (landed !== lastRoll) {
    if (landed > lastRoll && landed >= 0) {
      const pips = ROLLS[landed]!.v; // in range: landed >= 0 indexes ROLLS
      if (pips < 5) sound.miss();
      else sound.hit(pips === 6);
      rollAt = t;
    }
    lastRoll = landed;
  }
  const dieOn = C > 1.55 && C < 2.75;
  die.visible = dieOn;
  if (dieOn) {
    const next = ROLLS.find((r) => d < r.at),
      prev = landed >= 0 ? ROLLS[landed] : null;
    let rot = FACE_UP[prev ? prev.v : 1],
      spin = 0,
      bounce = 0;
    if (next) {
      const u = range(d, next.at - 0.13, next.at);
      if (u > 0) {
        rot = FACE_UP[next.v];
        spin = 1 - easeOut(u);
        bounce = Math.sin(u * Math.PI) * 0.55;
        if (u < 0.05 && !reduced) sound.roll();
      }
    }
    const appear = easeOut(range(C, 1.55, 1.8)) * (1 - range(C, 2.55, 2.75));
    die.position.set(0, 2.45 + bounce + (reduced ? 0 : Math.sin(t * 1.6) * 0.05), 0.2);
    e3.set(rot[0] + spin * (Math.PI * 4), rot[1] + spin * (Math.PI * 3), rot[2] + spin * (Math.PI * 2));
    die.quaternion.setFromEuler(e3).premultiply(DIE_TILT);
    if (!reduced) die.rotateOnWorldAxis(Y_AXIS, Math.sin(t * 0.9) * 0.18);
    die.scale.setScalar(Math.max(0.001, appear));
  }
  const hpB = 100 - (landed >= 0 ? 34 : 0) - (landed >= 2 ? 50 : 0);
  const duelTags = C > 1.75 && C < 2.6;
  T.roll.set(
    lastRoll >= 0
      ? `<span class="n">${ROLLS[lastRoll]!.v}</span><span class="t">${ROLLS[lastRoll]!.text}</span>` // in range: lastRoll >= 0
      : '<span class="n">d6</span><span class="t">Challenger swings first</span>',
  );
  placeTag(T.roll, v.set(0, 3.35, 0.2), duelTags);
  T.hpB.set(`Rival · ${hpB} HP<span class="bar"><i style="width:${hpB}%"></i></span>`);
  placeTag(T.hpA, v.set(heroHome.x, -0.05, 0.6), duelTags && Boolean(hero));
  placeTag(T.hpB, v.set(DUEL_X, -0.05, 0.6), duelTags && Boolean(rival));
  placeTag(T.challenge, v.set(heroHome.x, (hero?.height || 2) + 0.25, 0.15), C > 1.5 && C < 2.05 && !portrait);
  placeTag(T.fight, v.set(DUEL_X, (rival?.height || 2) + 0.25, 0.15), C > 1.62 && C < 2.05 && !portrait);
  placeTag(T.lookReply, v.set(0.9, 0.05, 1.7), C > 0.7 && C < 1.3 && !portrait);

  if (gold !== lastGold) {
    lastGold = gold;
    hoard.mesh.visible = chest.group.visible = gold > 0.005;
    hoard.cols.forEach((c, i) => {
      const k = clamp01(gold * 1.4 - Math.hypot(c.x, c.z) * 0.25),
        hh = Math.max(0.001, c.h * k);
      m4.makeScale(1, hh, 1).setPosition(c.x, hh / 2, c.z);
      hoard.mesh.setMatrixAt(i, m4);
    });
    hoard.mesh.instanceMatrix.needsUpdate = true;
    chest.group.scale.setScalar(Math.max(0.001, easeOut(clamp01(gold * 1.3))));
  }
  const open = reduced ? gold : ease(range(C, 3.6, 3.95)) * gold;
  chest.lid.rotation.x = -1.95 * open;
  chest.shaft.material.uniforms.uA.value = open;
  chest.shaft.material.uniforms.uTime.value = t;
  chest.light.intensity = open * 2.2;
  chest.gold.emissiveIntensity = 0.25 + open * 0.45;

  // coins spiral around the hero in the loot chapter
  const coinIn = range(C, 3.45, 3.95),
    coinOut = range(C, 4.55, 4.9);
  let ci = 0;
  if (coinIn > 0 && coinOut < 1) {
    for (let j = 0; j < coins.count; j++) {
      const g = easeOut(clamp01(coinIn * 1.6 - (j % 22) * 0.025)) * (1 - coinOut);
      if (g <= 0.01) continue;
      const ang = j * 2.4 + t * (reduced ? 0 : 0.55),
        rad = 0.95 + (j % 3) * 0.22;
      if (j < 22)
        v.set(
          heroHome.x + Math.cos(ang) * rad,
          lift + 0.35 + (j / 22) * 2.3 + (reduced ? 0 : Math.sin(t * 1.5 + j) * 0.06),
          heroHome.z + Math.sin(ang) * rad * 0.55 - 0.15,
        );
      else {
        // a shower of coins falling through the ring
        const k = j - 22,
          fall = reduced ? 0.5 : (t * (0.22 + (k % 5) * 0.03) + k * 0.137) % 1;
        v.set(Math.sin(k * 12.9) * 2.9, 5.2 - fall * 5.6, Math.cos(k * 7.3) * 1.6 - 0.6);
      }
      e3.set(0.25, ang * 2 + t * (reduced ? 0 : 2.2), 0);
      q.setFromEuler(e3);
      s.setScalar(g);
      const cm = new THREE.Matrix4().compose(v, q, s);
      for (const [a, b] of coins.disc) {
        m4.makeTranslation(a * coins.unit, b * coins.unit, 0).premultiply(cm);
        coins.mesh.setMatrixAt(ci++, m4);
      }
    }
  }
  coins.mesh.count = ci;
  coins.mesh.instanceMatrix.needsUpdate = true;

  // the lock-on bracket frames this chapter's subject; it fades out between chapters and glides to the next one
  const ch = Math.round(C);
  let lockOn: LockTarget | null = null,
    lockA = 1 - ease(range(Math.abs(C - ch), 0.18, 0.4));
  if (ch === 0 && hero) {
    lockOn = { ...LOCKS[0], boxes: [fbox(hero)] };
    lockA *= range(t - bornAt, 2.3, 2.9);
  } else if (ch === 1 && hero) lockOn = { ...LOCKS[1], boxes: [fbox(hero)] };
  else if (ch === 2 && hero && rival) lockOn = { ...LOCKS[2], boxes: [fbox(hero), fbox(rival)] };
  else if (ch === 3 && crowd[0]) lockOn = { ...LOCKS[3], boxes: [fbox(crowd[0].f, 0.1)] };
  else if (ch === 4 && hero && gold > 0.5) lockOn = { ...LOCKS[4], boxes: [fbox(hero)] };
  placeLock(lockOn, lockA, dt, portrait);
  placeTag(
    T.loss,
    v.set(chest.group.position.x + 0.25, 0.7, chest.group.position.z + 0.5),
    C > 3.7 && C < 4.45 && !portrait,
  );

  // the stream frame builds itself around the whole island at the end
  const fr = reduced ? (C > 4.5 ? 1 : 0) : range(C, 4.35, 4.95);
  if (fr !== lastFrame) {
    lastFrame = fr;
    frame3d.group.visible = fr > 0.001;
    frame3d.list.forEach((b, k) => {
      const p = easeOut(clamp01((fr - b.delay) / 0.55));
      v.set(b.x, b.y, 0).lerp(b.from, 1 - p);
      e3.set(b.spin * (1 - p), b.spin * 0.7 * (1 - p), 0);
      q.setFromEuler(e3);
      s.setScalar(Math.max(0.001, p));
      frame3d.mesh.setMatrixAt(k, m4.compose(v, q, s));
    });
    frame3d.mesh.instanceMatrix.needsUpdate = true;
    frame3d.edgeMat.opacity = range(fr, 0.8, 1);
  }
  const fy = frame3d.group.position.y - frame3d.h / 2 - frame3d.unit; // under the frame's bottom-left corner, clear of the moon
  placeTag(T.obsL, v.set(-frame3d.w / 2 - frame3d.unit, fy, 0.4), fr > 0.97);

  const tm = reduced ? 0.25 : 1;
  sky.material.uniforms.uTime.value = t;
  embers.material.uniforms.uTime.value = t * tm;
  embers.material.uniforms.uBurst.value = lastRoll === 2 && t - rollAt < 0.8 ? (1 - (t - rollAt) / 0.8) * 2 : 0;
  lanterns.flames.forEach((f) => {
    f.mesh.material.emissiveIntensity =
      2.8 + (reduced ? 0 : Math.sin(t * 9 + f.seed) * 0.35 + Math.sin(t * 23 + f.seed * 3) * 0.2);
  });
  islets.list.forEach((it, i) => {
    it.g.position.y = it.y + (reduced ? 0 : Math.sin(t * 0.4 + it.seed) * 0.25);
    it.g.rotation.y = reduced ? 0 : t * 0.03 * (i % 2 ? 1 : -1);
  });
  film.uniforms.uTime.value = t;
  film.uniforms.uFray.value = reduced ? 0 : ease(range(Math.abs(targetC - C), 0.05, 0.6)) * 0.5;
  if (Math.abs(targetC - C) > 0.02) film.uniforms.uDir.value = Math.sign(targetC - C);
  film.uniforms.uHit.value = reduced ? 0 : hitK;
  island.userData.rune.uI.value = 1.1 + hitK * 2.6 + (reduced ? 0 : Math.sin(t * 1.3) * 0.12);
  island.userData.rune.uTime.value = t * tm;
  for (const m of clouds.mats) m.uniforms.uTime.value = t * tm;

  composer.render(dt);
}
const Y_AXIS = new THREE.Vector3(0, 1, 0),
  DIE_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.15);
const COL_BRASS = new THREE.Color().setRGB(0.82, 0.63, 0.33, THREE.SRGBColorSpace);
const COL_STONE_A = new THREE.Color().setRGB(0.25, 0.27, 0.31, THREE.SRGBColorSpace);
const COL_RUNE = new THREE.Color().setRGB(1.0, 0.5, 0.14, THREE.SRGBColorSpace);
const COL_STONE_B = new THREE.Color().setRGB(0.19, 0.2, 0.24, THREE.SRGBColorSpace);

// once the opening has played, 40 frames with a median over 22 ms (under ~45 fps) drop one quality step
let running = true,
  lastTs = 0,
  frameMs: number[] = [];
function govern(ts: number) {
  const d = ts - lastTs;
  lastTs = ts;
  if (quality === QUALITY.length - 1 || now - bornAt < 3 || d > 250) return; // gaps from a hidden tab don't count
  frameMs.push(d);
  if (frameMs.length < 40) return;
  const median = frameMs.sort((a, b) => a - b)[20]!; // in range: 40 samples
  frameMs = [];
  if (median > 22) {
    quality++;
    if (gtao) gtao.enabled = false;
    resize();
  }
}
function loop(ts: number) {
  timer.update(ts);
  if (running) {
    frame();
    govern(ts);
  }
  requestAnimationFrame(loop);
}
document.addEventListener("visibilitychange", () => (running = !document.hidden));

// first frame, then hide the loader; restore the sound choice on the first click anywhere
try {
  if (localStorage.getItem("pixfray-intro-sound") === "1")
    addEventListener(
      "pointerdown",
      () => {
        if (!sound.on) setSound(true);
      },
      { once: true },
    );
} catch {
  /* private mode */
}
// draw everything once behind the loader, hidden and off-screen things too: the die, chest, hoard, beam and frame otherwise
// finish compiling the first time they're drawn (ANGLE compiles at draw time), a stall of a third of a second mid-scroll
// The podium's per-cube colours exist from the start too: made on first use, they switch its material to another shader.
// Twice: three draws the shadow map before it counts the lights, so the first draw builds shadow shaders for a scene with no
// lights, and the ones real frames use would still compile mid-scroll (the instanced podium and coins, the chest).
{
  if (!podium.mesh.instanceColor) podium.mesh.setColorAt(0, COL_STONE_B);
  const hidden: THREE.Object3D[] = [],
    culled: THREE.Object3D[] = [],
    empty: { count?: number | undefined }[] = [];
  // only an InstancedMesh has isInstancedMesh and count
  scene.traverse((o: THREE.Object3D & { isInstancedMesh?: boolean; count?: number | undefined }) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
    if (o.frustumCulled) {
      culled.push(o);
      o.frustumCulled = false;
    }
    if (o.isInstancedMesh && o.count === 0) {
      empty.push(o);
      o.count = 1;
    }
  });
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  for (const o of hidden) o.visible = false;
  for (const o of culled) o.frustumCulled = true;
  for (const o of empty) o.count = 0;
}
// a link to a chapter (/#ladder) opens on that chapter, framed, instead of flying there from the start
const linked = sections.find((sec) => location.hash === "#" + sec.id);
if (linked) {
  centerChapter(linked);
  C = targetC = scrollC();
}
timer.update();
frame();
finishLoading(() => (bornAt = now));
requestAnimationFrame(loop);
window.__intro = {
  get C() {
    return C;
  },
  setC(x) {
    targetC = C = x;
    vC = 0;
  },
  get quality() {
    return { step: quality, pixelRatio: renderer.getPixelRatio() };
  },
};
if (import.meta.env.DEV)
  Object.assign(window.__intro, {
    scene,
    composer,
    gtao,
    bloom,
    film,
    island,
    hero,
    hoard,
    chest,
    frame3d,
    islets,
    clouds,
    embers,
    sky,
  });
