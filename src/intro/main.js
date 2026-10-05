// PixFray intro page. One fixed WebGL stage; the scroll position becomes a chapter coordinate C (0..5) that drives
// the camera along a spline and every scene beat (fighters assembling, the duel, the ladder, coins, the OBS frame).
// Text lives in normal DOM sections over the stage, so the page reads without the 3D.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { createSound } from './sound.js';
import { loadImage, sampleSprite, VoxelFighter } from './voxels.js';
import { buildSky, buildIsland, buildLanterns, buildEmbers, buildIslets, buildDie, FACE_UP, buildPodium, buildCoins, buildClouds, buildChest, buildHoard, buildFrame } from './world.js';

const $ = (s) => document.querySelector(s);
const CHANNEL = 'nesszerra';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = matchMedia('(max-width: 760px)').matches;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const range = (x, a, b) => clamp01((x - a) / (b - a));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
if (reduced) document.body.classList.add('no-motion');

// ---------- headings type in word by word ----------
for (const h of document.querySelectorAll('[data-type]')) {
  const text = h.textContent.trim();
  h.setAttribute('aria-label', text);
  h.innerHTML = text.split(' ').map((w, i) => `<span class="w" aria-hidden="true" style="--i:${i}">${esc(w)}</span>`).join(' ');
}

// ---------- loader ----------
const loader = $('#loader'), grid = loader.querySelector('.loader-grid'), pct = $('#loader-pct');
const cells = Array.from({ length: 100 }, () => grid.appendChild(document.createElement('i')));
const order = cells.map((_, i) => i).sort((a, b) => Math.sin(a * 91.7) - Math.sin(b * 91.7));
let shown = 0;
function setProgress(f) {
  const n = Math.round(clamp01(f) * 100);
  for (; shown < n; shown++) { cells[order[shown]].className = 'on'; }
  cells.forEach((c) => c.classList.remove('hot'));
  if (shown > 0 && shown < 100) cells[order[shown - 1]].classList.add('hot');
  pct.textContent = n + '%';
}
let bornAt = 1e9;   // the hero assembles once the loader lifts, so the first thing people see is the knight forming
function finishLoading() {
  setProgress(1);
  setTimeout(() => { bornAt = now; loader.classList.add('is-done'); document.body.classList.remove('is-loading'); }, reduced ? 0 : 350);
}

// ---------- live ladder (DOM) ----------
async function loadBoard() {
  try {
    const r = await fetch('/api/leaderboard/' + CHANNEL, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    const rows = (await r.json()).filter((x) => x && x.username).slice(0, 5);
    if (!rows.length) throw new Error('empty');
    $('#board').innerHTML = rows.map((x) => `<li><span>${esc(x.displayName || x.username)}<span class="rec">${x.wins}–${x.losses}</span></span><b>${x.elo}</b></li>`).join('');
    $('#board-source').innerHTML = `Live from nesszerra's channel, Elo with wins–losses. <a href="/?channel=${CHANNEL}#ranks">Full list</a>`;
    return rows;
  } catch {
    $('#board').innerHTML = '<li class="muted">The live ranks did not load.</li>';
    $('#board-source').innerHTML = `<a href="/?channel=${CHANNEL}#ranks">See the ranks on the channel page</a>`;
    return [];
  }
}

// ---------- sound toggle ----------
const sound = createSound();
const soundBtn = $('#sound');
function setSound(on) {
  sound.setOn(on);
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.querySelector('.sound-label').textContent = on ? 'Sound on' : 'Sound off';
  try { localStorage.setItem('pixfray-intro-sound', on ? '1' : '0'); } catch { /* private mode */ }
}
soundBtn.addEventListener('click', () => setSound(!sound.on));

// ---------- scroll -> chapter coordinate ----------
const sections = [...document.querySelectorAll('.chapter')];
const railItems = [...document.querySelectorAll('#rail li')];
let bounds = [];
function measure() { bounds = sections.map((s) => ({ top: s.offsetTop, h: s.offsetHeight })); }
function scrollC() {
  const y = scrollY + innerHeight * 0.5;
  if (scrollY <= 2) return 0;
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    if (y < b.top + b.h) return Math.max(0, Math.min(5, i + (y - b.top) / b.h - 0.5));
  }
  return 5;
}
let activeChapter = -1, activeCopy = -1;
// the copy is fixed in place while its chapter is on, so a keyboard user tabbing into another chapter's link scrolls that chapter in
document.addEventListener('focusin', (e) => {
  const sec = e.target.closest?.('.chapter');
  if (sec && !sec.classList.contains('is-on') && !document.body.classList.contains('no-motion')) {
    const b = bounds[sections.indexOf(sec)];
    if (b) scrollTo({ top: b.top + b.h / 2 - innerHeight / 2, behavior: 'instant' });
  }
});
// the rail follows the nearest chapter; the copy shows only near a chapter's centre, so text never sits on a scene change
function setChapter(c) {
  const i = Math.round(c), copy = reduced || Math.abs(c - i) < 0.36 ? i : -1;
  if (copy !== activeCopy) { activeCopy = copy; sections.forEach((s, k) => s.classList.toggle('is-on', k === copy)); }
  if (i === activeChapter) return;
  activeChapter = i;
  railItems.forEach((li, k) => { li.classList.toggle('is-on', k === i); li.querySelector('a').toggleAttribute('aria-current', k === i); });
  if (i > 0) sound.chapter(i);
}

// ---------- 3D ----------
const canvas = $('#stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('webgl2');
} catch {
  document.body.classList.add('no-webgl', 'no-motion');
  measure(); setChapter(0);
  addEventListener('scroll', () => { setChapter(document.body.classList.contains('no-motion') ? Math.round(scrollC()) : scrollC()); document.body.classList.toggle('scrolled', scrollY > 40); }, { passive: true });
  loadBoard().then(finishLoading);
  throw new Error('PixFray intro: WebGL2 is not available; showing the text only.');
}

const DPR = Math.min(devicePixelRatio || 1, small ? 1.5 : 2);
renderer.setPixelRatio(DPR);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = !small;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0d0906, small ? 0.022 : 0.027);
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 200);

const sky = buildSky(); scene.add(sky);
// a baked night for reflections: dark sky, a moon high behind, warm lantern panels around the ring.
// Brass, gold, the ring and the wet floor pick it up; matte stone barely does.
{
  const env = new THREE.Scene(), box = new THREE.BoxGeometry(1, 1, 1);
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 24, 12), new THREE.MeshBasicMaterial({ color: 0x1a120c, side: THREE.BackSide })));
  const glow = (c, x, y, z, sx, sy, sz) => { const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: c })); m.position.set(x, y, z); m.scale.set(sx, sy, sz); env.add(m); };
  glow(0xd8d0c4, 0, 12, -14, 4, 4, 1);                                   // moon
  glow(0x6a4a30, 0, -10, 0, 30, 1, 30);                                  // warm floor bounce
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; glow(0xffa040, Math.cos(a) * 9, 2, Math.sin(a) * 9, 1.4, 2.4, 1.4); }
  glow(0x3a4a7a, -16, 6, 4, 1, 10, 14);                                  // cool fill side
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}
const hemi = new THREE.HemisphereLight(0x8a6a4a, 0x120c08, 0.5); scene.add(hemi);
// a cool fill from the front left, against the warm lanterns: two-tone cubes read as solid
const cool = new THREE.DirectionalLight(0x5d7cff, 0.5); cool.position.set(-6, 1.6, 1.5); scene.add(cool);
const key = new THREE.DirectionalLight(0xffcf96, 1.5); key.position.set(4.5, 7.5, 5.5);
key.castShadow = !small; key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 22 });
key.shadow.bias = -0.0008; key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(0x9db2ff, 0.9); rim.position.set(-1.5, 10, -8); scene.add(rim);
const warm = [[-3.2, 1.9, 2.6], [3.3, 1.9, 2.2], [0.2, 1.9, -3.6]].map(([x, y, z]) => { const l = new THREE.PointLight(0xff9a40, 16, 10, 2); l.position.set(x, y, z); scene.add(l); return l; });

const island = buildIsland({ shadows: !small }); scene.add(island);
const lanterns = buildLanterns(); scene.add(lanterns.group);
const embers = buildEmbers(small ? 380 : 900); scene.add(embers);
const islets = buildIslets(); scene.add(islets.group);
const die = buildDie(); die.visible = false; scene.add(die);
const podium = buildPodium(); scene.add(podium.mesh);
const coins = buildCoins(); scene.add(coins.mesh);
const clouds = buildClouds(); scene.add(clouds.group);
const chest = buildChest(); chest.group.position.set(-1.75, 0, 1.25); chest.group.rotation.y = 0.62; chest.group.visible = false; scene.add(chest.group);
const hoard = buildHoard(); hoard.mesh.position.set(0, 0, 0.2); hoard.mesh.visible = false; scene.add(hoard.mesh);
const frame3d = buildFrame(); frame3d.group.position.set(0, -0.7, 0); frame3d.group.visible = false; scene.add(frame3d.group);
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
const film = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 }, uFray: { value: 0 }, uHit: { value: 0 }, uDir: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) }, uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uAspect, uFray, uHit, uDir; uniform vec2 uRes; uniform vec3 uLift, uGain; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv; float frayed = 0.0, tilePx = 1.0; vec2 tileF = vec2(0.5);
      // pixel fray: while the camera travels between chapters, blocks of the frame snap to coarse pixels and slip
      // in the travel direction; the band of frayed blocks sweeps down (or up) the screen as it goes
      if (uFray > 0.001) {
        float bs = 9.0 * uRes.y / 900.0;
        vec2 blk = floor(vUv * uRes / (bs * 6.0));
        float tick = floor(uTime * 12.0), r = h(blk + tick);
        float band = fract(-uDir * uTime * 0.55), dy = abs(vUv.y - band);
        float sweep = smoothstep(0.2, 0.0, min(dy, 1.0 - dy));
        if (r < uFray * sweep * 1.3) {
          tilePx = bs * (1.5 + floor(h(blk * 1.7 + tick) * 3.0));
          vec2 pc = vUv * uRes / tilePx; tileF = fract(pc);
          uv = (floor(pc) + 0.5) * tilePx / uRes;
          uv.y += uDir * h(blk.xx + tick) * 0.085 * uFray;
          uv.x += (h(blk.yy + tick) - 0.5) * 0.04 * uFray;
          frayed = 1.0;
        }
      }
      vec2 d0 = vUv - 0.5;
      float ca = 0.0016 + uFray * 0.006 + uHit * 0.014;
      vec2 split = frayed * vec2(0.0, uDir * 0.006 * uFray);   // frayed blocks split red and blue along the travel
      vec3 c = vec3(texture2D(tDiffuse, uv + d0 * ca + split).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - d0 * ca - split).b);
      float steps = mix(256.0, 10.0, frayed);   // frayed blocks drop to a few colour steps
      c = floor(c * steps + 0.5) / steps;
      if (frayed > 0.5) {   // each coarse pixel drawn as a little cube: a dark seam, a lit top and left edge
        float g = max(1.0, uRes.y / 900.0) / tilePx;
        float seam = max(step(tileF.x, g), step(1.0 - g, tileF.y));
        float lit = max(step(1.0 - 3.0 * g, tileF.y), step(tileF.x, 3.0 * g));
        c = c * mix(1.0 + 0.16 * lit, 0.7, seam) + vec3(0.012, 0.008, 0.004) * lit;
      }
      // chapter grade: a tinted lift in the shadows and a per-channel gain
      c = c * uGain + uLift * (1.0 - clamp(dot(c, vec3(0.3, 0.59, 0.11)) * 2.0, 0.0, 1.0));
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      c *= mix(1.0, 0.52, smoothstep(0.35, 1.05, length(d)));
      c += (h(vUv * 1000.0 + fract(uTime) * 61.0) - 0.5) * 0.028;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(film);

// ---------- tags pinned to 3D points ----------
const tagLayer = $('#tags');
const proj = new THREE.Vector3();
function makeTag(cls, html) {
  const el = document.createElement('div'); el.className = 'tag';
  el.innerHTML = `<div class="${cls}">${html}</div>`;
  tagLayer.appendChild(el);
  return { el, inner: el.firstChild, on: false, set(html) { if (this.html !== html) { this.inner.innerHTML = html; this.html = html; } } };
}
function placeTag(tag, pos, visible) {
  if (visible) {
    proj.copy(pos).project(camera);
    const lim = tag.corner ? 0.985 : 0.9;   // frame-corner labels are anchored by their own edge, so they may sit near the screen edge
    if (proj.z > 1 || Math.abs(proj.x) > lim || Math.abs(proj.y) > 0.9) visible = false;
    else {
      let x = (proj.x + 1) / 2 * innerWidth;
      if (!tag.call && !tag.corner) { const hw = (tag.w ||= tag.el.firstElementChild.offsetWidth) / 2 + 8; x = Math.min(innerWidth - hw, Math.max(hw, x)); }
      tag.el.style.transform = `translate3d(${x.toFixed(1)}px, ${((1 - proj.y) / 2 * innerHeight).toFixed(1)}px, 0)`;
    }
  }
  if (visible !== tag.on) { tag.on = visible; tag.el.classList.toggle('on', visible); }
}
// callouts: a dot on the 3D point, a leader line, then a title and one line of detail
function makeCall(title, sub, cls = '') {
  return Object.assign(makeTag('tag-call ' + cls, `<i class="dot"></i><i class="lead"></i><span class="txt"><b>${title}</b><span>${sub}</span></span>`), { call: true });
}
const scrimL = document.createElement('div'), scrimR = document.createElement('div');
scrimL.className = 'scrim scrim-l'; scrimR.className = 'scrim scrim-r';
document.body.insertBefore(scrimL, tagLayer); document.body.insertBefore(scrimR, tagLayer);

// ---------- loading ----------
const tasks = [];
let done = 0;
const track = (p) => { tasks.push(p); p.finally(() => { done++; setProgress(0.08 + 0.84 * done / tasks.length); }); return p; };
setProgress(0.04);

const boardP = track(loadBoard());
const catalogP = track(fetch('/assets/characters.json').then((r) => r.json()));
track(document.fonts?.load('650 40px Fraunces') ?? Promise.resolve());

const catalog = await catalogP.catch(() => []);
const byId = new Map(catalog.map((c) => [c.id, c]));
const rows = await boardP;
const FALLBACK_CROWD = ['adventurer', 'pixel-bot', 'cowgirl', 'bunny-brown', 'cute-girl'];
const crowdPeople = (rows.length ? rows : FALLBACK_CROWD.map((a) => ({ avatar: a }))).slice(0, 5).map((r, i) => ({ ...r, avatar: byId.has(r.avatar) ? r.avatar : FALLBACK_CROWD[i] }));
const wanted = [...new Set(['knight', 'toon-ranger', ...crowdPeople.map((p) => p.avatar)])].filter((id) => byId.has(id));
const images = new Map();
await Promise.all(wanted.map((id) => track(loadImage(byId.get(id).url).then((img) => images.set(id, img)).catch(() => {}))));

function fighter(id, height, opts, density = 15) {
  const c = byId.get(id), img = images.get(id);
  if (!c || !img) return null;
  const frame = c.animations?.idle?.[0] || c.frames[0];
  const targetRows = Math.round(height * (small ? density * 0.75 : density));
  const step = Math.max(2, Math.round(frame.h / targetRows));
  const sprite = sampleSprite(img, frame, step);
  const f = new VoxelFighter(sprite, { size: height / sprite.rows, ...opts });
  scene.add(f.group);
  return f;
}
const hero = fighter('knight', 2.3, { scatter: 'burst', seed: 3, shadows: !small, layers: 4 }, 23);
const rival = fighter('toon-ranger', 2.15, { scatter: 'burst', seed: 7, shadows: !small, layers: 4 }, 23);
if (rival) rival.group.scale.x = -1;
const crowd = crowdPeople.map((p, i) => ({ person: p, f: fighter(p.avatar, 1.35, { scatter: 'rain', seed: 11 + i, shadows: !small, layers: 3 }) })).filter((c) => c.f);

// podium: rank 1 in the middle, then 2 left, 3 right, 4 and 5 outside
const PODIUM_X = [0, -1.25, 1.25, -2.5, 2.5], PODIUM_Z = -2.05, DUEL_X = 1.15;
const stacks = [16, 12, 10, 8, 7];   // levels by rank (1st tallest); the Elo itself is on the tag
const DUEL_SPOT = [[-2.6, -1.3], [-1.6, -2.4], [0.1, -2.95], [1.2, -3.3], [-3.3, -2.6]];   // the crowd steps back to the ropes for the duel
// a column of light over the rank 1 tower
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.62, 16, 20, 1, true), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uA: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `uniform float uA, uTime; varying vec2 vUv;
    void main(){ float band = 0.75 + 0.25 * step(0.5, fract(vUv.y * 22.0 - uTime * 0.8));
      float a = uA * sqrt(sqrt(max(1.0 - vUv.y, 0.0))) * (1.0 - smoothstep(0.85, 1.0, vUv.y)) * band * 0.32;
      gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a, a); }`,
}));
beam.visible = false; scene.add(beam);
const CROWD_SPOT = [[-2.8, -1.0], [-1.9, -2.3], [0.2, -3.1], [1.9, -2.3], [2.8, -1.0]];

// tags
const T = {
  look: makeTag('tag-line', '<b style="color:#c9a45c">you</b> !look'),
  lookReply: makeTag('tag-line', '<b style="color:#e7c27c">PixFray</b> @you, change your look here: pixfray.xyz/?channel=nesszerra#fighter'),
  challenge: makeTag('tag-line', '<b style="color:#c9a45c">challenger</b> !challenge @rival'),
  fight: makeTag('tag-line', '<b style="color:#7fa7d9">rival</b> !fight'),
  roll: makeTag('tag-roll', ''),
  hpA: makeTag('tag-hp', ''),
  hpB: makeTag('tag-hp', ''),
  win: makeCall('+$5 a win', 'plus an upgrade point'),
  loss: makeCall('+$3 a loss', 'every finished duel pays'),
  jump: makeTag('tag-jump', '!jump'),
  obsL: makeTag('tag-obs', '<b>OBS browser source</b> overlay link'),
  obsR: makeTag('tag-obs end', '1920 × 1080'),
};
T.obsL.corner = T.obsR.corner = true;
T.hp = makeCall('100 HP', 'one d6 roll per swing, 12 swings a duel');
T.knight = makeCall('Knight', `one of ${catalog.length || 56} fighters, rebuilt from ${hero ? hero.count.toLocaleString('en-US') : 'a few thousand'} cubes`);
const names = crowd.map((c) => makeTag('tag-line', `<b style="color:${esc(c.person.color || '#c9a45c')}">${esc(c.person.displayName || c.person.username || c.person.avatar)}</b>`));
const ranks = crowd.map((c, i) => makeTag('tag-rank', c.person.username ? `<b>${c.person.elo}</b>${i + 1}. ${esc(c.person.displayName || c.person.username)}` : ''));

// ---------- moods ----------
// each chapter is its own world: ember arena, teal dusk for chat, crimson duel, cold moonlit ladder, gold loot, blue night stream
const MOODS = [
  { fog: 0x0d0906, fogD: 0.027, cloud: 0x4a3020, sky: [1, 1, 1], hemi: 0x8a6a4a, key: 0xffcf96, keyI: 1.8, cool: 0x5d7cff, coolI: 0.5, warm: 0xff9a40, warmI: 1, moon: 1, lift: [0, 0, 0], gain: [1, 1, 1] },
  { fog: 0x061110, fogD: 0.025, cloud: 0x1f4846, sky: [0.5, 1.15, 1.25], hemi: 0x3f7a76, key: 0xffd7a8, keyI: 1.5, cool: 0x46d0c4, coolI: 1.3, warm: 0xff9a40, warmI: 0.95, moon: 1, lift: [0, 0.02, 0.026], gain: [0.86, 1.03, 1.08] },
  { fog: 0x120506, fogD: 0.027, cloud: 0x4a1a16, sky: [1.45, 0.6, 0.55], hemi: 0x7a4038, key: 0xffa27a, keyI: 1.95, cool: 0x7c66ff, coolI: 0.6, warm: 0xff6a34, warmI: 1.05, moon: 0, lift: [0.014, 0, 0.004], gain: [1.03, 0.97, 0.95] },
  { fog: 0x050a16, fogD: 0.024, cloud: 0x2c3c66, sky: [0.45, 0.75, 1.7], hemi: 0x45578a, key: 0x9fb8ff, keyI: 1.45, cool: 0x7090ff, coolI: 1.7, warm: 0xffa850, warmI: 0.55, moon: 1, lift: [0, 0.004, 0.022], gain: [0.9, 0.98, 1.12] },
  { fog: 0x130c02, fogD: 0.026, cloud: 0x5a3c12, sky: [1.45, 1.15, 0.45], hemi: 0x9a7a3a, key: 0xffd27a, keyI: 2.5, cool: 0x5d7cff, coolI: 0.35, warm: 0xffb040, warmI: 1.6, moon: 0.4, lift: [0.03, 0.02, 0.006], gain: [1.2, 1.1, 0.9] },
  { fog: 0x070913, fogD: 0.011, cloud: 0x2a3560, sky: [0.6, 0.7, 1.35], hemi: 0x6a7090, key: 0xffd9a8, keyI: 1.9, cool: 0x6a86ff, coolI: 1.1, warm: 0xffa040, warmI: 1.35, moon: 1, lift: [0, 0, 0.012], gain: [0.98, 1, 1.05] },
].map((m) => ({ ...m, cloud: new THREE.Color(m.cloud), fog: new THREE.Color(m.fog), hemi: new THREE.Color(m.hemi), key: new THREE.Color(m.key), cool: new THREE.Color(m.cool), warm: new THREE.Color(m.warm) }));
const mixN = (a, b, f) => a + (b - a) * f;
function applyMood(C) {
  const i = Math.min(4, Math.floor(C)), f = ease(clamp01(C - i)), a = MOODS[i], b = MOODS[i + 1];
  scene.fog.color.copy(a.fog).lerp(b.fog, f);
  scene.fog.density = mixN(a.fogD, b.fogD, f) * FOG;
  for (const m of clouds.mats) { m.uniforms.uDeep.value.copy(scene.fog.color); m.uniforms.uLit.value.copy(a.cloud).lerp(b.cloud, f); }
  hemi.color.copy(a.hemi).lerp(b.hemi, f);
  key.color.copy(a.key).lerp(b.key, f); key.intensity = mixN(a.keyI, b.keyI, f);
  cool.color.copy(a.cool).lerp(b.cool, f); cool.intensity = mixN(a.coolI, b.coolI, f);
  warm.forEach((l) => l.color.copy(a.warm).lerp(b.warm, f));
  sky.material.uniforms.uMoon.value = mixN(a.moon, b.moon, f);
  rim.intensity = 0.25 + 0.45 * sky.material.uniforms.uMoon.value;
  lanterns.cone.uniforms.uColor.value.copy(a.warm).lerp(b.warm, f);
  sky.material.uniforms.uMul.value.set(...a.sky.map((x, j) => mixN(x, b.sky[j], f)));
  film.uniforms.uLift.value.set(...a.lift.map((x, j) => mixN(x, b.lift[j], f)));
  film.uniforms.uGain.value.set(...a.gain.map((x, j) => mixN(x, b.gain[j], f)));
  return mixN(a.warmI, b.warmI, f);
}

// ---------- camera path ----------
// each key looks at its subject; setViewOffset then slides the picture away from the copy (SIDE: +1 right, -1 left)
const KEYS = [
  { pos: [0.9, 1.15, 6.1], look: [0, 1.4, 0] },
  { pos: [0.8, 7.4, 6.9], look: [0, 0.5, -1.0] },
  { pos: [0.3, 0.7, 7.6], look: [0, 1.75, 0] },
  { pos: [0.4, 1.0, 7.6], look: [0, 3.7, -2.05] },
  { pos: [2.6, 2.2, 5.6], look: [-0.5, 1.75, 0.1] },
  { pos: [-3.2, 3.0, 28.6], look: [0, -0.5, 0] },
];
const SIDE = [1, 1, -1, 1, -1, 0.95];
function sideAt(C) { const i = Math.min(4, Math.floor(C)), f = ease(clamp01(C - i)); return SIDE[i] + (SIDE[i + 1] - SIDE[i]) * f; }
const posCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k.pos)), false, 'centripetal');
const lookCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => new THREE.Vector3(...k.look)), false, 'centripetal');
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmp = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
function cameraAt(C, portrait) {
  const u = C / 5;
  posCurve.getPoint(u, camPos);
  lookCurve.getPoint(u, camLook);
  if (portrait) {   // narrow screens: step back; the view offset lifts the scene above the text
    tmp.copy(camPos).sub(camLook); camPos.copy(camLook).addScaledVector(tmp, 1.3 + 0.45 * clamp01(1 - Math.abs(C - 3)) - 0.1 * clamp01((C - 3.5) * 2) + 0.75 * clamp01((C - 4.3) / 0.7));
    camLook.y += 0.9 * clamp01(1 - Math.abs(C - 3) * 1.5);
    camLook.y += 0.8 * clamp01(1 - Math.abs(C - 4) * 1.5);   // the hero stands on the hoard   // look up the ladder towers   // ladder towers need room; loot and stream come closer
  }
}

// ---------- pointer ----------
const pointer = new THREE.Vector2(0, 0), pointerSmooth = new THREE.Vector2(0, 0);
let pointerIn = false;
const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit = new THREE.Vector3();
addEventListener('pointermove', (e) => { pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); pointerIn = e.pointerType === 'mouse'; }, { passive: true });
document.addEventListener('pointerleave', () => { pointerIn = false; });
let overHero = false, jumpAt = -10;
addEventListener('click', (e) => {
  if (!overHero || e.target.closest('a, button, .copy')) return;
  jumpAt = now; sound.jump();
});
addEventListener('keydown', (e) => { if (e.key === 'j' && !e.target.closest('input, textarea')) { jumpAt = now; sound.jump(); } });

// ---------- state ----------
let C = 0, targetC = 0;
const ROLLS = [{ at: 0.22, v: 5, by: 'a', text: 'Challenger hits for 34' }, { at: 0.5, v: 3, by: 'b', text: 'Rival misses' }, { at: 0.78, v: 6, by: 'a', text: 'Challenger crits for 50' }];
let lastRoll = -1, rollAt = -10;
const timer = new THREE.Timer();
let now = 0;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w / 2, h / 2);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 50 : w / h < 1.2 ? 44 : 36;
  camera.updateProjectionMatrix();
  film.uniforms.uAspect.value = w / h;
  film.uniforms.uRes.value.set(w * DPR, h * DPR);
  embers.material.uniforms.uPx.value = DPR * h / 900;
  measure();
  targetC = scrollC();
}
addEventListener('resize', resize);
addEventListener('scroll', () => { targetC = scrollC(); document.body.classList.toggle('scrolled', scrollY > 40); }, { passive: true });
resize();

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
const heroHome = new THREE.Vector3();
let lastGold = -1, lastFrame = -1;

function frame() {
  const dt = Math.min(0.05, timer.getDelta()), t = (now = timer.getElapsed());
  if (reduced) C = Math.round(targetC);
  else C += (targetC - C) * (1 - Math.exp(-dt * 3.2));
  if (Math.abs(targetC - C) < 1e-4) C = targetC;
  setChapter(targetC);
  const portrait = innerWidth / innerHeight < 0.9;

  // camera with a little cursor parallax; the picture slides away from the copy
  cameraAt(C, portrait);
  // opening shot: the camera starts wide and pushes in while the knight's cubes fly together
  const born = clamp01((t - bornAt) / 2.8);
  if (!reduced && born < 1) camPos.sub(camLook).multiplyScalar(1 + 0.45 * (1 - ease(born))).add(camLook);
  const W = innerWidth, H = innerHeight, side = sideAt(C);
  if (portrait) camera.setViewOffset(W, H, 0, H * 0.26, W, H);
  else camera.setViewOffset(W, H, -side * W * (0.17 + 0.018 * clamp01(1 - C * 2)), 0, W, H);
  scrimL.style.opacity = portrait ? '0' : clamp01(side).toFixed(3);
  scrimR.style.opacity = portrait ? '0' : clamp01(-side).toFixed(3);
  pointerSmooth.lerp(reduced ? pointerSmooth.set(0, 0) : pointer, 1 - Math.exp(-dt * 4));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  if (!reduced) {
    right.setFromMatrixColumn(camera.matrix, 0); up.setFromMatrixColumn(camera.matrix, 1);
    camera.position.addScaledVector(right, pointerSmooth.x * 0.28).addScaledVector(up, pointerSmooth.y * 0.16);
    camera.lookAt(camLook);
  }
  const hitAge = t - rollAt, hitK = lastRoll >= 0 && ROLLS[lastRoll].by === 'a' && hitAge < 0.6 ? (1 - hitAge / 0.6) * (ROLLS[lastRoll].v === 6 ? 1 : 0.45) : 0;
  if (hitK > 0 && !reduced) camera.position.add(tmp.set(Math.sin(t * 61) * 0.06, Math.sin(t * 47) * 0.05, 0).multiplyScalar(hitK));

  // hero: centre, steps left for the duel, breaks into cubes while the ladder shows, rebuilds at the centre for the loot
  const duelIn = ease(range(C, 1.35, 1.85)), back = C > 3;
  const heroX = back ? 0 : -DUEL_X * duelIn;
  const heroGone = range(C, 2.62, 2.85) - range(C, 3.35, 3.7);
  const gold = reduced ? (C > 3.5 && C < 4.5 ? 1 : 0) : ease(range(C, 3.4, 3.85)) * (1 - ease(range(C, 4.4, 4.75)));
  const lift = hoard.top * gold;
  const roll = range(C, 1.62, 2.55);
  const d = reduced && C >= 2 && C < 3 ? 1 : roll;
  let lunge = 0;
  if (hero) {
    heroHome.set(heroX, 0, back ? 0.2 : 0.15 * duelIn);
    const since = t - jumpAt, jumpY = since < 0.6 ? Math.sin((since / 0.6) * Math.PI) * 0.8 : 0;
    const lastA = ROLLS.filter((r) => r.by === 'a' && d >= r.at).pop();
    if (lastA && t - rollAt < 0.35 && ROLLS[lastRoll] === lastA) lunge = Math.sin(((t - rollAt) / 0.35) * Math.PI) * 0.35;
    hero.group.position.set(heroHome.x + lunge, jumpY + lift, heroHome.z);
    if (!reduced) hero.group.scale.y = 1 + Math.sin(t * 2.1) * 0.008;
    // cursor push: intersect the pointer ray with the hero's plane, in hero-local units
    overHero = false;
    if (pointerIn && C < 4.6) {
      ray.setFromCamera(pointer, camera);
      plane.constant = -hero.group.position.z;
      if (ray.ray.intersectPlane(plane, hit)) {
        const lx = hit.x - hero.group.position.x, ly = hit.y - hero.group.position.y;
        const inside = Math.abs(lx) < hero.width * 0.6 && ly > -0.2 && ly < hero.height * 1.08;
        overHero = inside;
        hero.pointer = inside && !reduced ? { x: lx, y: ly } : null;
      } else hero.pointer = null;
    } else hero.pointer = null;
    document.body.style.cursor = overHero ? 'pointer' : '';
    hero.update(reduced ? (heroGone > 0.5 ? 0 : 1) : Math.min(range(t - bornAt, 0.15, 2.3), 1 - heroGone));
    placeTag(T.jump, v.set(hero.group.position.x, hero.group.position.y + hero.height + 0.35, 0), t - jumpAt < 0.9);
    placeTag(T.knight, v.set(hero.group.position.x + hero.width * 0.2, hero.height * 0.84, 0.2), C < 0.4 && t - bornAt > 2.4 && !portrait);
    placeTag(T.hp, v.set(hero.group.position.x + hero.width * 0.26, hero.height * 0.3, 0.2), C < 0.4 && t - bornAt > 2.9 && !portrait);
  }

  // crowd rains in during chapter 1, climbs the podium in chapter 3
  const climb = ease(range(C, 2.75, 3.05)) * (1 - ease(range(C, 3.4, 3.75)));
  const grow = range(C, 2.7, 3.0) * (1 - range(C, 3.45, 3.8));
  let pi = 0;
  crowd.forEach((c, i) => {
    const a = Math.min(range(C, 0.3 + i * 0.07, 0.68 + i * 0.06), 1 - range(C, 3.42 + i * 0.03, 3.68 + i * 0.03) + range(C, 4.4 + i * 0.05, 4.8 + i * 0.05));
    const sx = CROWD_SPOT[i][0] + (DUEL_SPOT[i][0] - CROWD_SPOT[i][0]) * duelIn, sz = CROWD_SPOT[i][1] + (DUEL_SPOT[i][1] - CROWD_SPOT[i][1]) * duelIn;
    const px = PODIUM_X[i], h = Math.round(stacks[i] * grow) * podium.cell;
    c.f.group.position.set(sx + (px - sx) * climb, h * climb, sz + (PODIUM_Z - sz) * climb);
    c.f.update(reduced ? (C >= 0.5 ? 1 : 0) : a);
    placeTag(names[i], v.set(c.f.group.position.x, c.f.group.position.y + c.f.height + 0.12, c.f.group.position.z), a > 0.92 && C < 1.45 && (!portrait || i % 2 === 0));
    placeTag(ranks[i], v.set(px, h + c.f.height + 0.12, PODIUM_Z), C > 2.95 && C < 3.4 && !portrait && Boolean(c.person.username));
    if (i === 0) { beam.visible = climb > 0.01; beam.position.set(px, h + 8, PODIUM_Z); beam.material.uniforms.uA.value = climb; beam.material.uniforms.uTime.value = t; }
    // podium column: 2x2 cubes per level, brass at the top
    const levels = Math.round(stacks[i] * grow);
    for (let l = 0; l < levels; l++) for (let k = 0; k < 4; k++) {
      m4.makeTranslation(px + ((k & 1) - 0.5) * podium.cell, (l + 0.5) * podium.cell - 0.0, PODIUM_Z + ((k >> 1) - 0.5) * podium.cell);
      podium.mesh.setMatrixAt(pi, m4);
      podium.mesh.setColorAt(pi, l === levels - 1 ? COL_BRASS : l % 4 === 2 && k === 3 - (i % 2) ? COL_RUNE : (l + k) % 2 ? COL_STONE_A : COL_STONE_B);
      pi++;
    }
  });
  podium.mesh.count = pi;
  podium.mesh.instanceMatrix.needsUpdate = true; if (podium.mesh.instanceColor) podium.mesh.instanceColor.needsUpdate = true;

  // rival and the duel
  if (rival) {
    const ra = range(C, 1.4, 1.8) * (1 - range(C, 2.62, 2.85));
    let shake = 0;
    const lastB = ROLLS[lastRoll];
    if (lastB && lastB.by === 'a' && t - rollAt < 0.5) shake = Math.sin(t * 70) * 0.05 * (1 - (t - rollAt) / 0.5);
    rival.group.position.set(DUEL_X + shake, 0, 0.15);
    rival.update(reduced ? (ra > 0.5 ? 1 : 0) : ra);
  }
  // which roll has landed (scroll can run backwards)
  let landed = -1; ROLLS.forEach((r, i) => { if (d >= r.at) landed = i; });
  if (landed !== lastRoll) {
    if (landed > lastRoll && landed >= 0) { const r = ROLLS[landed]; if (r.v === 6) sound.hit(true); else if (r.v === 5) sound.hit(false); else sound.miss(); rollAt = t; }
    lastRoll = landed;
  }
  const dieOn = C > 1.55 && C < 2.75;
  die.visible = dieOn;
  if (dieOn) {
    const next = ROLLS.find((r) => d < r.at), prev = landed >= 0 ? ROLLS[landed] : null;
    let rot = FACE_UP[prev ? prev.v : 1], bounce = 0;
    if (next) {
      const u = range(d, next.at - 0.13, next.at);
      if (u > 0) { const k = 1 - easeOut(u); rot = FACE_UP[next.v].map((x, j) => x + k * [Math.PI * 4, Math.PI * 3, Math.PI * 2][j]); bounce = Math.sin(u * Math.PI) * 0.55; if (u > 0 && u < 0.05 && !reduced) sound.roll(); }
    }
    const appear = easeOut(range(C, 1.55, 1.8)) * (1 - range(C, 2.55, 2.75));
    die.position.set(0, 2.45 + bounce + (reduced ? 0 : Math.sin(t * 1.6) * 0.05), 0.2);
    e3.set(rot[0], rot[1], rot[2]); die.quaternion.setFromEuler(e3).premultiply(DIE_TILT);
    if (!reduced) die.rotateOnWorldAxis(Y_AXIS, Math.sin(t * 0.9) * 0.18);
    die.scale.setScalar(Math.max(0.001, appear));
  }
  const hpB = 100 - (landed >= 0 ? 34 : 0) - (landed >= 2 ? 50 : 0);
  const duelTags = C > 1.75 && C < 2.6;
  T.roll.set(lastRoll >= 0 ? `<span class="n">${ROLLS[lastRoll].v}</span><span class="t">${ROLLS[lastRoll].text}</span>` : '<span class="n">d6</span><span class="t">Challenger swings first</span>');
  placeTag(T.roll, v.set(0, 3.35, 0.2), duelTags);
  T.hpA.set(`Challenger · 100 HP<span class="bar"><i style="width:100%"></i></span>`);
  T.hpB.set(`Rival · ${hpB} HP<span class="bar"><i style="width:${hpB}%"></i></span>`);
  placeTag(T.hpA, v.set(heroHome.x, -0.05, 0.6), duelTags && Boolean(hero));
  placeTag(T.hpB, v.set(DUEL_X, -0.05, 0.6), duelTags && Boolean(rival));
  placeTag(T.challenge, v.set(heroHome.x, (hero?.height || 2) + 0.25, 0.15), C > 1.5 && C < 2.05 && !portrait);
  placeTag(T.fight, v.set(DUEL_X, (rival?.height || 2) + 0.25, 0.15), C > 1.62 && C < 2.05 && !portrait);
  placeTag(T.look, v.set(0, (hero?.height || 2) + 0.3, 0), C > 0.62 && C < 1.3);
  placeTag(T.lookReply, v.set(0.9, 0.05, 1.7), C > 0.78 && C < 1.3 && !portrait);

  // the hoard and the chest
  if (gold !== lastGold) {
    lastGold = gold;
    hoard.mesh.visible = chest.group.visible = gold > 0.005;
    hoard.cols.forEach((c, i) => {
      const k = clamp01(gold * 1.4 - Math.hypot(c.x, c.z) * 0.25), hh = Math.max(0.001, c.h * k);
      m4.makeScale(1, hh, 1).setPosition(c.x, hh / 2, c.z); hoard.mesh.setMatrixAt(i, m4);
    });
    hoard.mesh.instanceMatrix.needsUpdate = true;
    chest.group.scale.setScalar(Math.max(0.001, easeOut(clamp01(gold * 1.3))));
  }
  const open = reduced ? gold : ease(range(C, 3.6, 3.95)) * gold;
  chest.lid.rotation.x = -1.95 * open;
  chest.shaft.material.uniforms.uA.value = open; chest.shaft.material.uniforms.uTime.value = t;
  chest.light.intensity = open * 2.2;
  chest.gold.emissiveIntensity = 0.25 + open * 0.45;

  // coins spiral around the hero in the loot chapter
  const coinIn = range(C, 3.45, 3.95), coinOut = range(C, 4.55, 4.9);
  let ci = 0;
  if (coinIn > 0 && coinOut < 1) {
    for (let j = 0; j < coins.count; j++) {
      const g = easeOut(clamp01(coinIn * 1.6 - (j % 22) * 0.025)) * (1 - coinOut);
      if (g <= 0.01) continue;
      const ang = j * 2.4 + t * (reduced ? 0 : 0.55), rad = 0.95 + (j % 3) * 0.22;
      if (j < 22) v.set(heroHome.x + Math.cos(ang) * rad, lift + 0.35 + (j / 22) * 2.3 + (reduced ? 0 : Math.sin(t * 1.5 + j) * 0.06), heroHome.z + Math.sin(ang) * rad * 0.55 - 0.15);
      else {   // a shower of coins falling through the ring
        const k = j - 22, fall = reduced ? 0.5 : ((t * (0.22 + (k % 5) * 0.03) + k * 0.137) % 1);
        v.set(Math.sin(k * 12.9) * 2.9, 5.2 - fall * 5.6, Math.cos(k * 7.3) * 1.6 - 0.6);
      }
      e3.set(0.25, ang * 2 + t * (reduced ? 0 : 2.2), 0); q.setFromEuler(e3); s.setScalar(g);
      const cm = new THREE.Matrix4().compose(v, q, s);
      for (const [a, b] of coins.disc) { m4.makeTranslation(a * coins.unit, b * coins.unit, 0).premultiply(cm); coins.mesh.setMatrixAt(ci++, m4); }
    }
  }
  coins.mesh.count = ci; coins.mesh.instanceMatrix.needsUpdate = true;
  placeTag(T.win, v.set(heroHome.x - 2.0, lift + 1.5, 0.5), C > 3.6 && C < 4.45 && !portrait);
  placeTag(T.loss, v.set(chest.group.position.x + 0.25, 0.7, chest.group.position.z + 0.5), C > 3.7 && C < 4.45 && !portrait);

  // the stream frame builds itself around the whole island at the end
  const fr = reduced ? (C > 4.5 ? 1 : 0) : range(C, 4.35, 4.95);
  if (fr !== lastFrame) {
    lastFrame = fr;
    frame3d.group.visible = fr > 0.001;
    frame3d.list.forEach((b, k) => {
      const p = easeOut(clamp01((fr - b.delay) / 0.55));
      v.set(b.x, b.y, 0).lerp(b.from, 1 - p);
      e3.set(b.spin * (1 - p), b.spin * 0.7 * (1 - p), 0); q.setFromEuler(e3); s.setScalar(Math.max(0.001, p));
      frame3d.mesh.setMatrixAt(k, m4.compose(v, q, s));
    });
    frame3d.mesh.instanceMatrix.needsUpdate = true;
    frame3d.edgeMat.opacity = range(fr, 0.8, 1);
  }
  const fy = frame3d.group.position.y + frame3d.h / 2 + frame3d.unit;
  placeTag(T.obsL, v.set(-frame3d.w / 2 - frame3d.unit, fy, 0.4), fr > 0.97);
  placeTag(T.obsR, v.set(frame3d.w / 2 + frame3d.unit, fy, 0.4), fr > 0.97 && !portrait);   // too narrow for both on a phone

  // ambience
  const tm = reduced ? 0.25 : 1;
  sky.material.uniforms.uTime.value = t;
  embers.material.uniforms.uTime.value = t * tm;
  embers.material.uniforms.uBurst.value = lastRoll === 2 && t - rollAt < 0.8 ? (1 - (t - rollAt) / 0.8) * 2 : 0;
  lanterns.flames.forEach((f, i) => { f.mesh.material.emissiveIntensity = 2.8 + (reduced ? 0 : Math.sin(t * 9 + f.seed) * 0.35 + Math.sin(t * 23 + f.seed * 3) * 0.2); });
  const warmI = applyMood(C);
  warm.forEach((l, i) => { l.intensity = warmI * 16 + (reduced ? 0 : Math.sin(t * 7 + i * 2) * 1.5 + Math.sin(t * 17 + i) * 0.8); });
  islets.list.forEach((it, i) => { it.g.position.y = it.y + (reduced ? 0 : Math.sin(t * 0.4 + it.seed) * 0.25); it.g.rotation.y = reduced ? 0 : t * 0.03 * (i % 2 ? 1 : -1); });
  film.uniforms.uTime.value = t;
  film.uniforms.uFray.value = reduced ? 0 : ease(range(Math.abs(targetC - C), 0.05, 0.6)) * 0.72;
  if (Math.abs(targetC - C) > 0.02) film.uniforms.uDir.value = Math.sign(targetC - C);
  film.uniforms.uHit.value = reduced ? 0 : hitK;
  island.userData.rune.uI.value = 1.1 + hitK * 2.6 + (reduced ? 0 : Math.sin(t * 1.3) * 0.12);
  island.userData.rune.uTime.value = t * tm;
  for (const m of clouds.mats) m.uniforms.uTime.value = t * tm;

  composer.render(dt);
}
const Y_AXIS = new THREE.Vector3(0, 1, 0), DIE_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.15);
const COL_BRASS = new THREE.Color().setRGB(0.82, 0.63, 0.33, THREE.SRGBColorSpace);
const COL_STONE_A = new THREE.Color().setRGB(0.25, 0.27, 0.31, THREE.SRGBColorSpace);
const COL_RUNE = new THREE.Color().setRGB(1.0, 0.5, 0.14, THREE.SRGBColorSpace);
const COL_STONE_B = new THREE.Color().setRGB(0.19, 0.2, 0.24, THREE.SRGBColorSpace);

let running = true;
function loop(ts) { timer.update(ts); if (running) frame(); requestAnimationFrame(loop); }
document.addEventListener('visibilitychange', () => { running = !document.hidden; });

// first frame, then hide the loader; restore the sound choice on the first click anywhere
try { if (localStorage.getItem('pixfray-intro-sound') === '1') addEventListener('pointerdown', () => { if (!sound.on) setSound(true); }, { once: true }); } catch { /* private mode */ }
timer.update(); frame();
finishLoading();
requestAnimationFrame(loop);
window.__intro = { get C() { return C; }, setC(x) { targetC = C = x; } };
if (import.meta.env.DEV) Object.assign(window.__intro, { scene, composer, gtao, bloom, film, island, hero, hoard, chest, frame3d });
