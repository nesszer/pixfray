// The fighter page's 3D preview: the viewer's fighter rebuilt as voxels, standing in the intro's night arena.
// Loaded lazily by dashboard.ts; if WebGL is missing or the page runs slowly, the card keeps the 2D stage only.
// set({ body, pet }) takes canvases already drawn by ui.ts (hat, recolor and accessory included) and re-assembles
// the voxels when the look changes. Drag turns the fighter; the cursor nudges its cubes aside.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { sampleSprite, VoxelFighter, type VoxelOptions } from "./intro/voxels.ts";
import {
  addNightLights,
  bakeNightEnv,
  buildEmbers,
  buildIsland,
  buildIslets,
  buildLanterns,
  buildSky,
} from "./intro/world.ts";

const HEIGHT = 2.1; // the fighter's height in world units (a floor cell is 0.34)
const AWAKE_MS = 8000; // the arena animates this long after the last input, then holds still and stops drawing

// look: ui.ts composeLook() — the idle frame and the pet drawn flat, plus the key that names the whole look
export interface Look {
  key: string;
  body: HTMLCanvasElement;
  frameH: number;
  pet: HTMLCanvasElement | null;
  petH: number;
}
export type Fighter3D = { set: (look: Look | null | undefined) => void };

export function createFighter3D(canvas: HTMLCanvasElement, { zoom = 1 }: { zoom?: number } = {}): Fighter3D {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "low-power" });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error("webgl2");
  }
  let dpr = Math.min(devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0d0906, 0.03);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  const sky = buildSky();
  scene.add(sky);
  bakeNightEnv(renderer, scene);
  addNightLights(scene, {
    hemi: 0.55,
    cool: 0.55,
    key: 1.6,
    rim: 1.1,
    shadowMap: 1024,
    shadowBox: { left: -2.5, right: 2.5, top: 3.5, bottom: -1 },
  }).key.castShadow = true;
  const island = buildIsland({ shadows: true });
  scene.add(island);
  const lanterns = buildLanterns();
  scene.add(lanterns.group);
  const embers = buildEmbers(260);
  scene.add(embers);
  const islets = buildIslets();
  scene.add(islets.group);

  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
    composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.8);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // the fighter and its pet turn together on a turntable
  const table = new THREE.Group();
  scene.add(table);
  let fighter: VoxelFighter | null = null,
    pet: VoxelFighter | null = null,
    lookKey = "",
    builtAt = 0,
    buildMs = 1100;
  let wokeAt = performance.now(),
    drawn = 0,
    yaw = -0.32,
    yawTarget = -0.32,
    drag: { x: number; yaw: number } | null = null,
    hover: PointerEvent | null = null,
    visible = true,
    slow = false,
    dirty = true,
    raf = 0,
    last = 0;
  const frames: number[] = [];

  // src: a canvas; refH: the height in its pixels that stands for `height` world units; rows: cubes across refH
  function voxels(src: HTMLCanvasElement, refH: number, height: number, rows: number, opts: VoxelOptions) {
    const step = Math.max(1, Math.round(refH / rows));
    const s = sampleSprite(src, { x: 0, y: 0, w: src.width, h: src.height }, step);
    if (!s.cells.length) return null;
    return new VoxelFighter(s, { size: (step * height) / refH, scatter: "burst", shadows: true, ...opts });
  }
  // a swapped-out look bursts apart while the new one gathers in through it, so the stage is never empty
  const OUT = 460,
    leaving: { f: VoxelFighter; at: number }[] = [];

  function set(look: Look | null | undefined) {
    if (!look || look.key === lookKey) return;
    const first = !lookKey;
    lookKey = look.key;
    leaving.splice(0).forEach((l) => l.f.dispose());
    if (reduced || first) {
      fighter?.dispose();
      pet?.dispose();
    } else for (const f of [fighter, pet]) if (f) leaving.push({ f, at: performance.now() });
    const small = innerWidth < 700;
    fighter = voxels(look.body, look.frameH, HEIGHT, small ? 40 : 52, { layers: 14, seed: 3 });
    if (fighter) table.add(fighter.group);
    pet = look.pet ? voxels(look.pet, look.petH, HEIGHT * 0.42, small ? 16 : 22, { layers: 6, seed: 9 }) : null;
    if (pet) {
      pet.group.position.set(-1.0, 0, -0.4);
      table.add(pet.group);
    }
    builtAt = reduced ? -1e9 : performance.now();
    buildMs = leaving.length ? 750 : 1100;
    dirty = true;
    wake();
  }

  function resize() {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      // wider cards pull back so the arena shows; a short, wide card (the phone's sticky stage) steps in instead
      const strip = camera.aspect > 1.5 && h < 320,
        dist = strip ? 4.5 : (6.0 + Math.max(0, camera.aspect - 0.8) * 0.4) / zoom;
      camera.position.set(0, strip ? 1.45 : 1.85, dist);
      camera.lookAt(0, strip ? 1.0 : 1.3, 0);
      camera.updateProjectionMatrix();
      embers.material.uniforms.uPx.value = (dpr * h) / 900;
      dirty = true;
    }
    return true;
  }

  // sprites have depth but no back: turning stops short of side-on, with a little give past the limit that springs back on release
  const TURN = 0.7;
  const soft = (y: number) =>
    Math.abs(y) <= TURN ? y : Math.sign(y) * (TURN + Math.tanh((Math.abs(y) - TURN) * 2) * 0.2);

  // the cursor's point on the fighter's own plane, in its local space
  const ray = new THREE.Raycaster(),
    plane = new THREE.Plane(),
    hit = new THREE.Vector3(),
    nrm = new THREE.Vector3(),
    ndc = new THREE.Vector2();
  function pointerOn(f: VoxelFighter | null, e: PointerEvent) {
    if (!f) return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    f.group.updateWorldMatrix(true, false);
    nrm.set(0, 0, 1).transformDirection(f.group.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(nrm, hit.setFromMatrixPosition(f.group.matrixWorld));
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return f.group.worldToLocal(hit);
  }
  canvas.addEventListener("pointerdown", (e) => {
    wake();
    drag = { x: e.clientX, yaw: yawTarget };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      yawTarget = soft(drag.yaw + ((e.clientX - drag.x) / canvas.clientWidth) * Math.PI * 1.6);
      hover = null;
    } else if (e.pointerType === "mouse") hover = e;
    wake();
  });
  const release = () => {
    if (drag) canvas.closest(".showcase")?.classList.add("turned");
    drag = null;
    yawTarget = Math.max(-TURN, Math.min(TURN, yawTarget));
    canvas.classList.remove("is-dragging");
    kick();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    kick();
  });
  // keyboard: arrows turn the fighter when the canvas has focus
  canvas.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    yawTarget = Math.max(-TURN, Math.min(TURN, yawTarget + (e.key === "ArrowLeft" ? -0.35 : 0.35)));
    e.preventDefault();
    wake();
  });

  new IntersectionObserver(([en]) => {
    visible = en!.isIntersecting; // one observed canvas, so every callback has one entry
    if (visible) wake();
  }).observe(canvas);
  new ResizeObserver(() => {
    dirty = true;
    kick();
  }).observe(canvas);
  document.addEventListener("visibilitychange", wake);

  function wake() {
    wokeAt = performance.now();
    kick();
  }
  function kick() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    raf = 0;
    if (!canvas.isConnected || !resize()) return;
    // phones keep the card in view the whole time (sticky bar): idle at 30 fps there to save battery
    if (innerWidth < 900 && !drag && !dirty && now - drawn < 30) return kick();
    drawn = now;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    const t = now / 1000,
      live = !reduced && !slow;
    // the sway and breath ease out before the arena stops, so it comes to rest instead of freezing mid-turn
    const calm = Math.max(0, Math.min(1, (AWAKE_MS - (now - wokeAt)) / 2000)),
      awake = now - wokeAt < AWAKE_MS;
    const assembling = now - builtAt < 1400 || leaving.length > 0;
    const a = reduced ? 1 : Math.max(0, Math.min(1, (now - builtAt) / buildMs));
    // idle sway when nobody is dragging, so the voxels read as solid
    const sway = live && !drag ? Math.sin(t * 0.45) * 0.22 * calm : 0;
    yaw += (yawTarget + sway - yaw) * (1 - Math.exp(-dt * 6));
    table.rotation.y = yaw;
    for (let i = leaving.length - 1; i >= 0; i--) {
      const l = leaving[i]!, // in range: i counts down from leaving.length - 1
        k = (now - l.at) / OUT;
      if (k >= 1) {
        l.f.dispose();
        leaving.splice(i, 1);
      } else {
        l.f.pointer = null;
        l.f.update(1 - k);
      }
    }
    if (fighter) {
      fighter.pointer = hover && !drag ? pointerOn(fighter, hover) : null;
      fighter.update(a);
    }
    if (pet) {
      pet.pointer = null;
      pet.update(Math.max(0, a * 1.15 - 0.15));
    }
    for (const { mesh, seed } of lanterns.flames)
      mesh.material.emissiveIntensity = live
        ? 2.8 + Math.sin(t * 9 + seed) * 0.35 + Math.sin(t * 23 + seed * 3) * 0.2
        : 2.8;
    if (live) {
      sky.material.uniforms.uTime.value = t;
      embers.material.uniforms.uTime.value = t;
      island.userData.rune.uTime.value = t;
      if (fighter) fighter.group.position.y = Math.max(0, Math.sin(t * 2.2)) * 0.015 * calm; // a breath
    }
    composer.render(dt);
    dirty = false;
    // a slow machine (software rendering) gets a still arena: render only when something changes
    if (!slow && live) {
      frames.push(dt);
      if (frames.length === 50) {
        const avg = frames.reduce((x, y) => x + y, 0) / frames.length;
        if (avg > 0.045) {
          slow = true;
          dpr = 1;
          renderer.setPixelRatio(1);
          composer.setPixelRatio(1);
          bloom.enabled = false;
          dirty = true;
          canvas.width = 0;
        }
        frames.length = 0;
      }
    }
    const moving = Math.abs(yawTarget + sway - yaw) > 0.002 || drag || fighter?.settling || assembling;
    if ((live && awake) || moving || dirty) kick();
    else {
      last = 0;
      frames.length = 0;
    } // at rest: the next wake starts a fresh clock and a fresh speed sample
  }
  kick();
  return { set };
}
