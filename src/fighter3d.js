// The fighter page's 3D preview: the viewer's fighter rebuilt as voxels, standing in the intro's night arena.
// Loaded lazily by dashboard.js; if WebGL is missing or the page runs slowly, the card keeps the 2D stage only.
// set({ body, pet }) takes canvases already drawn by ui.js (hat, recolor and accessory included) and re-assembles
// the voxels when the look changes. Drag turns the fighter; the cursor nudges its cubes aside.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { sampleSprite, VoxelFighter } from './intro/voxels.js';
import { buildSky, buildIsland, buildLanterns, buildEmbers, buildIslets } from './intro/world.js';

const HEIGHT = 2.1;   // the fighter's height in world units (a floor cell is 0.34)

export function createFighter3D(canvas) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); throw new Error('webgl2'); }
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
  const sky = buildSky(); scene.add(sky);
  {
    // the intro's baked night for reflections: moon behind, warm lantern panels around, a cool side
    const env = new THREE.Scene(), box = new THREE.BoxGeometry(1, 1, 1);
    env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 24, 12), new THREE.MeshBasicMaterial({ color: 0x1a120c, side: THREE.BackSide })));
    const glow = (c, x, y, z, sx, sy, sz) => { const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: c })); m.position.set(x, y, z); m.scale.set(sx, sy, sz); env.add(m); };
    glow(0xd8d0c4, 0, 12, -14, 4, 4, 1);
    glow(0x6a4a30, 0, -10, 0, 30, 1, 30);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; glow(0xffa040, Math.cos(a) * 9, 2, Math.sin(a) * 9, 1.4, 2.4, 1.4); }
    glow(0x3a4a7a, -16, 6, 4, 1, 10, 14);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(env, 0.02).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }
  scene.add(new THREE.HemisphereLight(0x8a6a4a, 0x120c08, 0.55));
  const cool = new THREE.DirectionalLight(0x5d7cff, 0.55); cool.position.set(-6, 1.6, 1.5); scene.add(cool);
  const key = new THREE.DirectionalLight(0xffcf96, 1.6); key.position.set(4.5, 7.5, 5.5);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 3.5, bottom: -1, near: 1, far: 22 });
  key.shadow.bias = -0.0008; key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9db2ff, 1.1); rim.position.set(-1.5, 10, -8); scene.add(rim);
  for (const [x, y, z] of [[-3.2, 1.9, 2.6], [3.3, 1.9, 2.2], [0.2, 1.9, -3.6]]) { const l = new THREE.PointLight(0xff9a40, 16, 10, 2); l.position.set(x, y, z); scene.add(l); }
  const island = buildIsland({ shadows: true }); scene.add(island);
  const lanterns = buildLanterns(); scene.add(lanterns.group);
  const embers = buildEmbers(260); scene.add(embers);
  const islets = buildIslets(); scene.add(islets.group);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.8);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // the fighter and its pet turn together on a turntable
  const table = new THREE.Group(); scene.add(table);
  let fighter = null, pet = null, lookKey = '', builtAt = 0;
  let drawn = 0, yaw = -0.32, yawTarget = -0.32, drag = null, hover = null, visible = true, slow = false, dirty = true, raf = 0, last = 0;
  const frames = [];

  // src: a canvas; refH: the height in its pixels that stands for `height` world units; rows: cubes across refH
  function voxels(src, refH, height, opts) {
    const step = Math.max(1, Math.round(refH / opts.rows));
    const s = sampleSprite(src, { x: 0, y: 0, w: src.width, h: src.height }, step);
    if (!s.cells.length) return null;
    return new VoxelFighter(s, { size: step * height / refH, scatter: 'burst', layers: opts.layers, seed: opts.seed, shadows: true });
  }
  function drop(f) { if (!f) return; table.remove(f.group); f.mesh.geometry.dispose(); f.mesh.material.dispose(); f.mesh.dispose(); }

  // look: ui.js composeLook() — { key, body, frameH, pet, petH }
  function set(look) {
    if (!look || look.key === lookKey) return;
    lookKey = look.key;
    drop(fighter); drop(pet);
    const small = innerWidth < 700;
    fighter = voxels(look.body, look.frameH, HEIGHT, { rows: small ? 40 : 52, layers: 14, seed: 3 });
    if (fighter) table.add(fighter.group);
    pet = look.pet ? voxels(look.pet, look.petH, HEIGHT * 0.42, { rows: small ? 16 : 22, layers: 6, seed: 9 }) : null;
    if (pet) { pet.group.position.set(-1.0, 0, -0.4); table.add(pet.group); }
    builtAt = reduced ? -1e9 : performance.now();
    dirty = true; kick();
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      renderer.setSize(w, h, false); composer.setSize(w, h);
      camera.aspect = w / h;
      // frame the fighter: wider cards pull back a little so the arena shows around it
      // ...but a short, wide card (the phone's sticky stage) steps in so the fighter fills its height
      const strip = camera.aspect > 1.5 && h < 320, dist = strip ? 4.8 : 6.0 + Math.max(0, camera.aspect - 0.8) * 0.4;
      camera.position.set(0, strip ? 1.5 : 1.85, dist); camera.lookAt(0, strip ? 1.1 : 1.3, 0); camera.updateProjectionMatrix();
      embers.material.uniforms.uPx.value = dpr * h / 900;
      dirty = true;
    }
    return true;
  }

  // sprites have depth but no back: turning stops short of side-on, with a little give past the limit that springs back on release
  const TURN = 0.7;
  const soft = (y) => Math.abs(y) <= TURN ? y : Math.sign(y) * (TURN + Math.tanh((Math.abs(y) - TURN) * 2) * 0.2);

  // the cursor's point on the fighter's own plane, in its local space
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(), hit = new THREE.Vector3(), nrm = new THREE.Vector3();
  function pointerOn(f, e) {
    if (!f) return null;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, camera);
    f.group.updateWorldMatrix(true, false);
    nrm.set(0, 0, 1).transformDirection(f.group.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(nrm, hit.setFromMatrixPosition(f.group.matrixWorld));
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return f.group.worldToLocal(hit);
  }
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, yaw: yawTarget }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('is-dragging'); });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) { yawTarget = soft(drag.yaw + (e.clientX - drag.x) / canvas.clientWidth * Math.PI * 1.6); hover = null; }
    else if (e.pointerType === 'mouse') hover = e;
    kick();
  });
  const release = () => { if (drag) canvas.closest('.showcase')?.classList.add('turned'); drag = null; yawTarget = Math.max(-TURN, Math.min(TURN, yawTarget)); canvas.classList.remove('is-dragging'); kick(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { hover = null; kick(); });
  // keyboard: arrows turn the fighter when the canvas has focus
  canvas.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    yawTarget = Math.max(-TURN, Math.min(TURN, yawTarget + (e.key === 'ArrowLeft' ? -0.35 : 0.35))); e.preventDefault(); kick();
  });

  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) kick(); }).observe(canvas);
  new ResizeObserver(() => { dirty = true; kick(); }).observe(canvas);
  document.addEventListener('visibilitychange', kick);

  function kick() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    if (!canvas.isConnected || !resize()) return;
    // phones keep the card in view the whole time (sticky bar): idle at 30 fps there to save battery
    if (innerWidth < 900 && !drag && !dirty && now - drawn < 30) { kick(); return; }
    drawn = now;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    const t = now / 1000, live = !reduced && !slow;
    const assembling = now - builtAt < 1400;
    const a = reduced ? 1 : Math.min(1, (now - builtAt) / 1100);
    // idle sway when nobody is dragging, so the voxels read as solid
    const sway = live && !drag ? Math.sin(t * 0.45) * 0.22 : 0;
    yaw += (yawTarget + sway - yaw) * (1 - Math.exp(-dt * 6));
    table.rotation.y = yaw;
    if (fighter) { fighter.pointer = hover && !drag ? pointerOn(fighter, hover) : null; fighter.update(a); }
    if (pet) { pet.pointer = null; pet.update(Math.max(0, a * 1.15 - 0.15)); }
    if (live) {
      sky.material.uniforms.uTime.value = t;
      embers.material.uniforms.uTime.value = t;
      island.userData.rune.uTime.value = t;
      lanterns.flames.forEach((f) => { f.mesh.material.emissiveIntensity = 2.8 + Math.sin(t * 9 + f.seed) * 0.35 + Math.sin(t * 23 + f.seed * 3) * 0.2; });
      if (fighter) fighter.group.position.y = Math.max(0, Math.sin(t * 2.2)) * 0.015;   // a breath
    } else lanterns.flames.forEach((f) => { f.mesh.material.emissiveIntensity = 2.8; });
    composer.render(dt);
    dirty = false;
    // a slow machine (software rendering) gets a still arena: render only when something changes
    if (!slow && live) {
      frames.push(dt);
      if (frames.length === 50) {
        const avg = frames.reduce((x, y) => x + y, 0) / frames.length;
        if (avg > 0.045) { slow = true; dpr = 1; renderer.setPixelRatio(1); bloom.enabled = false; dirty = true; canvas.width = 0; }
        frames.length = 0;
      }
    }
    const moving = Math.abs(yawTarget + sway - yaw) > 0.002 || drag || hover || fighter?.settling || assembling;
    if (live || moving || dirty) kick();
  }
  kick();
  return { set, get slow() { return slow; }, get count() { return (fighter?.count || 0) + (pet?.count || 0); } };
}
