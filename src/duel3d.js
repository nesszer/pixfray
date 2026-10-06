// The overlay's 3D duel. public/overlay.js loads this (built to /assets/duel3d.js) when a duel starts; ?fx=off keeps
// duels 2D. The two fighters of one duel turn into voxel fighters on a small lantern-lit stage: bloom on sparks and hit
// flashes, cubes knocked loose by blows, a short freeze on impact and a camera push-in on the knockout.
// The 2D overlay stays in charge of the duel. Every frame it passes each fighter's pose (place, facing, sprite frame,
// lunge, hit flash, fall) and draws health bars, dice and names on its own canvas, which sits above this one.
// This canvas covers only the duel's corner of the screen, and between duels it is hidden and nothing renders.
// World units are screen pixels with y up, so a voxel fighter stands exactly where its 2D sprite stood.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { sampleSprite, VoxelFighter } from './intro/voxels.js';

const UNIT = 2.1;          // a sprite frame's height in voxel units; each fighter scales units to its 2D draw height
const ROWS = 40;           // cubes from the top to the bottom of a sprite frame
const YAW = 0.32;          // fighters turn their inner side toward the camera so the voxel depth shows
const IN_MS = 600, OUT_MS = 450;
const PUSH = 0.22, PUSH_IN = 250, PUSH_HOLD = 1600, PUSH_OUT = 700;
const CAMERA_DIST = 1200;
const SPARKS = 240, GRAVITY = 1500;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function createDuel3D() {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', left: '0px', top: '0px', pointerEvents: 'none', display: 'none' });
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'default' });
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); throw new Error('webgl2'); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the sprites' colours; ACES washes them out next to the 2D crowd
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(20, 1, 10, CAMERA_DIST + 4000);
  scene.add(new THREE.HemisphereLight(0xc8d6ff, 0x3a2614, 1.1));
  // directional lights keep their target at the origin, so only the direction of the position counts
  const key = new THREE.DirectionalLight(0xffd8a8, 1.9); key.position.set(0.5, 0.9, 1); scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb0ff, 1.8); rim.position.set(-0.7, 0.6, -1); scene.add(rim);
  const flashLight = new THREE.PointLight(0xffe2b8, 0, 0, 0); scene.add(flashLight);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.3, 0.85);
  // The canvas is transparent: bloom adds light to the colour only, and the last pass gives a glow pixel the alpha of
  // its (tone-mapped) brightness. Otherwise faint bloom leaves a dark veil over the whole region. Glow-only pixels
  // fade out toward the region's edges and the faintest haze is dropped, so the region never shows as a box.
  Object.assign(bloom.blendMaterial, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv); c.rgb = min(c.rgb, 1.0);
        vec2 d = min(vUv, 1.0 - vUv);
        float g = max(c.r, max(c.g, c.b));
        float k = smoothstep(0.0, 0.14, d.x) * smoothstep(0.0, 0.14, d.y) * smoothstep(0.015, 0.12, g);
        gl_FragColor = vec4(c.rgb * mix(k, 1.0, c.a), max(c.a, g * k));
      }`,
  }));

  // Sparks: small glowing cubes thrown off by blows. HDR colours (above 1) are what the bloom picks up.
  const sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), SPARKS);
  sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparkMesh.frustumCulled = false;
  const sp = { p: new Float32Array(SPARKS * 3), v: new Float32Array(SPARKS * 3), born: new Float64Array(SPARKS), life: new Float32Array(SPARKS), size: new Float32Array(SPARKS), spin: new Float32Array(SPARKS), freeze: new Float64Array(SPARKS) };
  let sparkNext = 0, sparksAlive = false;
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(), col = new THREE.Color();
  for (let i = 0; i < SPARKS; i++) { sparkMesh.setMatrixAt(i, m4.makeScale(0, 0, 0)); sparkMesh.setColorAt(i, col.set(0)); }
  scene.add(sparkMesh);
  function spark(x, y, z, color, count, { dir = 0, speed = 420, up = 0.6, freezeUntil = 0, size = 5 } = {}) {
    const now = Date.now();
    col.set(color).multiplyScalar(4);
    for (let n = 0; n < count; n++) {
      const i = sparkNext; sparkNext = (sparkNext + 1) % SPARKS;
      const a = (Math.random() - 0.5) * Math.PI * 1.4, sp0 = speed * (0.35 + Math.random() * 0.75);
      const dx = dir ? dir * Math.abs(Math.cos(a)) : Math.cos(a) * (Math.random() < 0.5 ? -1 : 1);
      sp.p.set([x, y, z], i * 3);
      sp.v.set([dx * sp0, (Math.sin(a) * 0.6 + up) * sp0, (Math.random() - 0.3) * sp0 * 0.8], i * 3);
      sp.born[i] = now; sp.life[i] = 450 + Math.random() * 450; sp.size[i] = size * (0.6 + Math.random() * 0.8);
      sp.spin[i] = Math.random() * 20; sp.freeze[i] = freezeUntil;
      sparkMesh.setColorAt(i, col);
    }
    sparkMesh.instanceColor.needsUpdate = true;
    sparksAlive = true;
  }
  function stepSparks(now, dt) {
    if (!sparksAlive) return;
    let alive = false;
    for (let i = 0; i < SPARKS; i++) {
      const age = now - sp.born[i];
      if (!sp.life[i] || age >= sp.life[i]) { if (sp.life[i]) { sp.life[i] = 0; sparkMesh.setMatrixAt(i, m4.makeScale(0, 0, 0)); } continue; }
      alive = true;
      const k = i * 3;
      if (now >= sp.freeze[i]) {   // a blow's hit stop holds its sparks in the air for a moment
        sp.v[k + 1] -= GRAVITY * dt;
        const drag = Math.exp(-dt * 2.2);
        sp.v[k] *= drag; sp.v[k + 2] *= drag;
        sp.p[k] += sp.v[k] * dt; sp.p[k + 1] += sp.v[k + 1] * dt; sp.p[k + 2] += sp.v[k + 2] * dt;
      }
      const left = 1 - age / sp.life[i];
      e3.set(sp.spin[i] * age / 1000, sp.spin[i] * 0.7 * age / 1000, 0); q4.setFromEuler(e3);
      m4.compose(v3.set(sp.p[k], sp.p[k + 1], sp.p[k + 2]), q4, s3.setScalar(sp.size[i] * Math.sqrt(left)));
      sparkMesh.setMatrixAt(i, m4);
    }
    sparkMesh.instanceMatrix.needsUpdate = true;
    sparksAlive = alive;
  }
  function clearSparks() {
    for (let i = 0; i < SPARKS; i++) { sp.life[i] = 0; sparkMesh.setMatrixAt(i, m4.makeScale(0, 0, 0)); }
    sparkMesh.instanceMatrix.needsUpdate = true; sparksAlive = false;
  }

  // A soft round shadow under each fighter, so the voxels stand on the stage.
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  // The stage: a strip of stone tiles under the two fighters with a glowing front edge and a lantern at each end.
  // Tiles rise into place in a wave from the middle when the duel turns 3D and sink away when it ends.
  function buildStage(x0, x1, feetY, s) {
    const group = new THREE.Group();
    const t = Math.max(6, Math.round(s * 0.16)), cols = Math.max(2, Math.ceil((x1 - x0) / t)), rows = 4, top = -feetY;
    const tileMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(t * 0.96, t * 0.7, t * 0.96), tileMat, cols * rows);
    tiles.frustumCulled = false;
    const home = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, shade = ((c + r) % 2 ? 0.2 : 0.25) + Math.random() * 0.04;
      tiles.setColorAt(i, col.setRGB(shade * 0.85, shade * 0.9, shade * 1.15, THREE.SRGBColorSpace));
      home.push({ x: x0 + (c + 0.5) * t, z: (r - 1.5) * t, delay: Math.abs(c - (cols - 1) / 2) / cols });
    }
    group.add(tiles);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(cols * t, t * 0.12, t * 0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(2.2) }));
    edge.position.set(x0 + cols * t / 2, top - t * 0.35, 2 * t + 1);
    group.add(edge);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.7 });
    const flames = [];
    for (const x of [x0 + t * 0.6, x0 + cols * t - t * 0.6]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(t * 0.45, s * 0.5, t * 0.45), postMat);
      post.position.set(x, top + s * 0.25, -t * 1.2);
      const flame = new THREE.Mesh(new THREE.BoxGeometry(t * 0.55, t * 0.7, t * 0.55), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff9a40).multiplyScalar(3) }));
      flame.position.set(x, top + s * 0.5 + t * 0.4, -t * 1.2);
      flames.push({ mesh: flame, seed: Math.random() * 10 });
      group.add(post, flame);
    }
    let shown = -1;
    function update(a, now) {
      if (a !== shown) {
        shown = a;
        home.forEach((h, i) => {
          const k = easeOut(clamp01((a - h.delay * 0.5) / 0.5));
          m4.compose(v3.set(h.x, top - t * 0.35 - (1 - k) * t * 2.5, h.z), q4.identity(), s3.setScalar(Math.max(0.001, k)));
          tiles.setMatrixAt(i, m4);
        });
        tiles.instanceMatrix.needsUpdate = true;
        edge.scale.set(Math.max(0.001, a), 1, 1);
      }
      for (const f of flames) {
        const flick = 1 + Math.sin(now / 1000 * 9 + f.seed) * 0.12 + Math.sin(now / 1000 * 23 + f.seed * 3) * 0.08;
        f.mesh.scale.set(a * flick, a * flick * (1 + Math.sin(now / 140 + f.seed) * 0.1), a * flick);
      }
    }
    function dispose() {
      group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      tiles.dispose();
    }
    return { group, update, dispose };
  }

  // One fighter: its voxel looks (one per sprite frame it has shown), a shadow and its hit state.
  const fighters = new Map();
  let builds = 0;
  function fighterFor(key, seed) {
    let f = fighters.get(key);
    if (f) return f;
    f = { key, outer: new THREE.Group(), inner: new THREE.Group(), looks: new Map(), cur: null, pose: null, hit: null, seed,
      shadow: new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })) };
    f.outer.add(f.inner);
    scene.add(f.outer, f.shadow);
    fighters.set(key, f);
    return f;
  }
  // src: { canvas, box } — a canvas holding one sprite frame (hat, recolor and accessory drawn in) and the frame's
  // rectangle inside it. sampleSprite centres the cubes on their own outline with the lowest cube at y = 0; the
  // offset below puts the frame's centre and bottom edge where the 2D sprite has them, so frames don't jump.
  function buildLook(src, seed) {
    const { canvas: c, box } = src;
    const step = Math.max(1, Math.round(box.h / ROWS));
    const s = sampleSprite(c, { x: 0, y: 0, w: c.width, h: c.height }, step);
    if (!s.cells.length) return null;
    let minQ = Infinity, maxQ = -Infinity, maxR = -Infinity;
    for (const cell of s.cells) { minQ = Math.min(minQ, cell.q); maxQ = Math.max(maxQ, cell.q); maxR = Math.max(maxR, cell.r); }
    const size = step * UNIT / box.h;
    const vf = new VoxelFighter(s, { size, layers: 10, scatter: 'burst', seed });
    const frameMidQ = (box.x + box.w / 2) / step - 0.5, bottomR = (box.y + box.h) / step - 1;
    vf.group.position.set(((minQ + maxQ) / 2 - frameMidQ) * size, (bottomR - maxR) * size, 0);
    return vf;
  }
  function dropLook(vf) { if (!vf) return; vf.group.removeFromParent(); vf.mesh.geometry.dispose(); vf.mesh.material.dispose(); vf.mesh.dispose(); }

  let phase = 'idle', t0 = 0, t1 = 0, stage = null, push = null, flash = null, quake = null, last = 0;
  const region = { x: 0, y: 0, w: 1, h: 1 }, focus = { x: 0, y: 0 };

  function teardown() {
    for (const f of fighters.values()) {
      for (const vf of f.looks.values()) dropLook(vf);
      f.outer.removeFromParent(); f.shadow.removeFromParent(); f.shadow.material.dispose();
    }
    fighters.clear();
    if (stage) { stage.group.removeFromParent(); stage.dispose(); stage = null; }
    clearSparks();
    push = flash = quake = null; flashLight.intensity = 0;
    phase = 'idle'; last = 0;
    canvas.style.display = 'none';
  }

  // xa, xb: the fighters' feet x; feetY: their floor line; s: their full duel size in pixels; vw, vh: the screen.
  function begin({ xa, xb, feetY, s, vw, vh }) {
    teardown();
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb), padX = s * 1.3 + 40;
    region.x = Math.max(0, Math.floor(lo - padX)); region.w = Math.max(1, Math.min(vw, Math.ceil(hi + padX)) - region.x);
    region.y = Math.max(0, Math.floor(feetY - s * 2.4)); region.h = Math.max(1, Math.min(vh, Math.ceil(feetY + s * 0.6)) - region.y);
    focus.x = (lo + hi) / 2; focus.y = feetY - s * 0.55;
    stage = buildStage(lo - s * 0.8, hi + s * 0.8, feetY, s);
    scene.add(stage.group);
    Object.assign(canvas.style, { left: region.x + 'px', top: region.y + 'px', width: region.w + 'px', height: region.h + 'px', display: 'block' });
    renderer.setSize(region.w, region.h, false); composer.setSize(region.w, region.h);
    camera.aspect = region.w / region.h;
    camera.fov = 2 * Math.atan(region.h / 2 / CAMERA_DIST) * 180 / Math.PI;
    phase = 'in'; t0 = Date.now();
  }
  function end() { if (phase === 'in' || phase === 'on') { phase = 'out'; t1 = Date.now(); } }

  // pose: { x, y (feet, screen px), h (2D draw height px), dir (1 right, -1 left), look (a key for this frame and
  // outfit), source() (returns { canvas, box } on first use of a look), fall (0..1 tipped over), flash (0..1) }
  function pose(key, ps) {
    if (phase === 'idle') return;
    const f = fighterFor(key, fighters.size * 7 + 3);
    f.pose = ps;
    let vf = f.looks.get(ps.look);
    if (vf === undefined) {
      if (builds >= 2 && f.cur) return;   // at most two new looks per frame; the last one holds meanwhile
      builds++;
      vf = buildLook(ps.source(), f.seed + f.looks.size);
      f.looks.set(ps.look, vf);
      if (vf) { vf.group.visible = false; f.inner.add(vf.group); }
    }
    if (vf && f.cur !== vf) { if (f.cur) f.cur.group.visible = false; f.cur = vf; vf.group.visible = true; }
  }
  const has = (key) => phase !== 'idle' && fighters.has(key);

  // A blow lands on `key`: cubes break loose around the impact, sparks fly out behind the target, a light flashes,
  // the 3D view trembles for the hit stop, and a finishing blow pushes the camera in.
  function hit(key, { color = 0xfb7185, heavy = false, crit = false, finisher = false, stop = 80 } = {}) {
    const f = fighters.get(key), ps = f?.pose;
    if (!ps || phase === 'idle') return;
    const now = Date.now();
    f.hit = { at: now, peak: finisher ? 1 : crit ? 0.6 : heavy ? 0.5 : 0.32, hold: finisher ? 350 : stop, tau: finisher ? 600 : 260 };
    const x = ps.x + ps.dir * ps.h * 0.18, y = -(ps.y - ps.h * 0.55);
    spark(x, y, 8, color, finisher ? 70 : crit ? 45 : heavy ? 30 : 20, { dir: -ps.dir, speed: finisher ? 620 : 440, up: 0.5, freezeUntil: now + stop, size: Math.max(3, ps.h * 0.05) });
    if (crit || finisher) spark(x, y, 8, 0xfff1c2, finisher ? 30 : 16, { speed: 300, up: 0.8, freezeUntil: now + stop, size: Math.max(2, ps.h * 0.035) });
    flash = { at: now, peak: finisher ? 2.5 : crit ? 1.8 : 1.1, x, y };
    quake = { at: now, until: now + stop + 60, mag: finisher ? 9 : crit ? 6 : 3 };
    if (finisher) push = { at: now };
  }
  // Loose sparks around a fighter (heals, knockdowns, respawns): rise drifts them upward.
  function burst(key, color, count, rise) {
    const ps = fighters.get(key)?.pose;
    if (!ps || phase === 'idle') return;
    spark(ps.x, -(ps.y - ps.h * (rise ? 0.3 : 0.5)), 6, color, count, { speed: rise ? 180 : 380, up: rise ? 1.4 : 0.7, size: Math.max(3, ps.h * 0.045) });
  }

  // The knockout push-in, as a zoom about `focus`: the overlay applies the same zoom to the duel's 2D health bars,
  // dice and names so they stay with the fighters.
  function view(now) {
    if (!push || phase === 'idle') return null;
    const t = now - push.at;
    if (t < 0 || t > PUSH_IN + PUSH_HOLD + PUSH_OUT) return null;
    const k = t < PUSH_IN ? easeOut(t / PUSH_IN) : t < PUSH_IN + PUSH_HOLD ? 1 : 1 - easeInOut((t - PUSH_IN - PUSH_HOLD) / PUSH_OUT);
    return { cx: focus.x, cy: focus.y, z: 1 + PUSH * k };
  }
  // How much of the duel the 3D view has taken over (0..1); the overlay fades its 2D sprites by the rest.
  function cover(now) {
    if (phase === 'in') return clamp01((now - t0) / 220);
    if (phase === 'on') return 1;
    if (phase === 'out') return 1 - clamp01((now - t1 - OUT_MS * 0.35) / (OUT_MS * 0.65));
    return 0;
  }

  // shake: the 2D overlay's own screen shake this frame, so both canvases move together.
  function render(now, shake = { x: 0, y: 0 }) {
    if (phase === 'idle') return false;
    builds = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now;
    let a = 1;
    if (phase === 'in') { a = clamp01((now - t0) / IN_MS); if (a >= 1) phase = 'on'; }
    else if (phase === 'out') { a = 1 - clamp01((now - t1) / OUT_MS); if (a <= 0) { teardown(); return false; } }
    stage.update(a, now);
    for (const f of fighters.values()) {
      const ps = f.pose, vf = f.cur;
      if (!ps || !vf) continue;
      const k = ps.h / UNIT;
      f.outer.position.set(ps.x, -ps.y, 0);
      f.outer.rotation.z = ps.dir * (ps.fall || 0) * Math.PI / 2;
      f.inner.rotation.y = -ps.dir * YAW;
      f.inner.scale.set(ps.dir * k, k, k);
      let hurt = 0;
      if (f.hit) {
        const t = now - f.hit.at;
        hurt = t < f.hit.hold ? f.hit.peak : f.hit.peak * Math.exp(-(t - f.hit.hold) / f.hit.tau);
        if (hurt < 0.01) { hurt = 0; f.hit = null; }
      }
      vf.hurt = Math.round(hurt * 100) / 100;
      vf.hurtAt.x = vf.width * 0.2; vf.hurtAt.y = vf.height * 0.58;
      vf.update(a);
      vf.mesh.material.emissive.setScalar((ps.flash || 0) * 0.32);
      const floor = stage ? 1 : 0, sw = ps.h * 0.75 * (1 + (ps.fall || 0) * 0.6);
      f.shadow.position.set(ps.x, -ps.y + 0.5 * floor, 4);
      f.shadow.scale.set(Math.max(0.001, sw * a), 1, Math.max(0.001, ps.h * 0.32 * a));
    }
    stepSparks(now, dt);
    if (flash) {
      const t = now - flash.at;
      flashLight.position.set(flash.x, flash.y, 80);
      flashLight.intensity = t < 0 ? 0 : flash.peak * Math.exp(-t / 140);
      if (t > 800) { flash = null; flashLight.intensity = 0; }
    }
    // camera: straight on at the region's centre, so the plane z = 0 maps 1:1 to the screen; the push-in zooms
    // about `focus`, keeping that point where it is on screen
    const v = view(now), z = v ? v.z : 1;
    const cx0 = region.x + region.w / 2, cy0 = -(region.y + region.h / 2), fx = focus.x, fy = -focus.y;
    let qx = 0, qy = 0;
    if (quake && now < quake.until) { qx = (Math.random() - 0.5) * 2 * quake.mag; qy = (Math.random() - 0.5) * 2 * quake.mag; }
    camera.position.set(fx - (fx - cx0) / z + qx, fy - (fy - cy0) / z + qy, CAMERA_DIST);
    camera.zoom = z;
    camera.updateProjectionMatrix();
    canvas.style.transform = shake.x || shake.y ? 'translate(' + shake.x.toFixed(1) + 'px,' + shake.y.toFixed(1) + 'px)' : '';
    composer.render(dt);
    return true;
  }

  // Compile the shaders now, while the fighters walk to meet, so the first 3D frame doesn't stall.
  {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(2, 0, 4, 8);
    const dummy = buildLook({ canvas: c, box: { x: 0, y: 0, w: 8, h: 8 } }, 1);
    const st = buildStage(0, 100, 100, 60);
    scene.add(dummy.group, st.group);
    renderer.setSize(2, 2, false); composer.setSize(2, 2);
    composer.render(0.016);
    dropLook(dummy); st.group.removeFromParent(); st.dispose();
  }

  return {
    canvas, begin, end, pose, has, hit, burst, view, cover, render,
    get phase() { return phase; },
    state: () => ({ phase, fighters: fighters.size, looks: [...fighters.values()].reduce((n, f) => n + f.looks.size, 0), region: { ...region } }),
  };
}

// Vite's app build drops an entry's exports, so the overlay (a plain script outside the bundle) finds this here.
globalThis.pixfrayDuel3D = createDuel3D;
