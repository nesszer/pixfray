// Voxel thumbnails for the picker tiles: each look (ui.js composeLook) is rebuilt as cubes, like the 3D preview,
// and rendered once at a three-quarter turn into the tile's own 2D canvas. One small WebGL context does every tile,
// a few per frame and only once a tile scrolls into view. Without WebGL the tiles keep their flat sprites.
import * as THREE from 'three';
import { sampleSprite, VoxelFighter } from './intro/voxels.js';

const SIZE = 160, GRID = 4;   // tiles are drawn GRID x GRID to an atlas, so reading them back costs one GPU sync per batch, not per tile
let renderer = null, scene, camera, broken = false;
const queue = [], cache = new Map(), waiting = new Map();   // waiting: canvas -> its latest job
let pumping = false;

function setup() {
  if (renderer || broken) return Boolean(renderer);
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE * GRID;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1); renderer.setSize(SIZE * GRID, SIZE * GRID, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  } catch { broken = true; renderer = null; return false; }
  scene = new THREE.Scene();
  // the preview's night light: warm key from the front right, cool rim behind, a dim warm floor bounce
  scene.add(new THREE.HemisphereLight(0xc09a70, 0x24180e, 1.15));
  const key = new THREE.DirectionalLight(0xffd6a0, 2.3); key.position.set(3, 5, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9db2ff, 1.6); rim.position.set(-4, 3, -5); scene.add(rim);
  camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
  return true;
}

// draws one look into atlas cell i (0 is the top left)
function render(look, i) {
  const step = Math.max(1, Math.round(look.frameH / 30));
  const sprite = sampleSprite(look.body, { x: 0, y: 0, w: look.body.width, h: look.body.height }, step);
  if (!sprite.cells.length) return null;
  const f = new VoxelFighter(sprite, { size: 0.07, layers: 8, scatter: 'burst', seed: 3 });
  f.update(1, true);
  // centre the cubes and fit the camera to them, so tall and wide characters both fill the tile
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < f.count; i++) { const x = f.home[i * 3], y = f.home[i * 3 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const turn = new THREE.Group(); turn.rotation.y = -0.62; turn.add(f.group); scene.add(turn);
  f.group.position.set(-(x0 + x1) / 2, -(y0 + y1) / 2, 0);
  const span = Math.max(y1 - y0, (x1 - x0) * 1.05) + f.size * 2;
  const dist = (span / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
  camera.position.set(0, dist * 0.32, dist); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
  const x = (i % GRID) * SIZE, y = (GRID - 1 - Math.floor(i / GRID)) * SIZE;   // WebGL counts y from the bottom
  renderer.setViewport(x, y, SIZE, SIZE); renderer.setScissor(x, y, SIZE, SIZE);
  renderer.render(scene, camera);
  scene.remove(turn); f.mesh.geometry.dispose(); f.mesh.material.dispose(); f.mesh.dispose();
  return true;
}
function copyCell(i) {
  const out = document.createElement('canvas'); out.width = out.height = SIZE;
  out.getContext('2d').drawImage(renderer.domElement, (i % GRID) * SIZE, Math.floor(i / GRID) * SIZE, SIZE, SIZE, 0, 0, SIZE, SIZE);
  return out;
}

function paint(target, img) {
  const g = target.getContext('2d');
  g.clearRect(0, 0, target.width, target.height);
  g.drawImage(img, 0, 0, target.width, target.height);
  target.parentElement?.classList.add('has-vox');
}

function pump() {
  pumping = false;
  const t0 = performance.now(), drawn = [], paints = [];
  renderer.setScissorTest(false); renderer.setViewport(0, 0, SIZE * GRID, SIZE * GRID); renderer.clear();
  renderer.setScissorTest(true);
  while (queue.length && drawn.length < GRID * GRID && performance.now() - t0 < 24) {
    const job = queue.shift();
    if (!job.target.isConnected) { if (waiting.get(job.target) === job) waiting.delete(job.target); continue; }
    if (waiting.get(job.target) !== job) continue;
    const look = job.make();
    // the sprite sheet isn't loaded yet: try again shortly
    if (!look) { if (++job.tries < 40) setTimeout(() => { if (waiting.get(job.target) === job) queue.push(job), wake(); }, 250); continue; }
    waiting.delete(job.target);
    const img = cache.get(look.key);
    if (img) { paints.push([job.target, img]); continue; }
    // the same look twice in one batch shares its cell
    const twin = drawn.find((d) => d.key === look.key);
    if (twin) { twin.targets.push(job.target); continue; }
    if (render(look, drawn.length)) drawn.push({ key: look.key, cell: drawn.length, targets: [job.target] });
  }
  renderer.setScissorTest(false);
  for (const d of drawn) {
    const img = copyCell(d.cell);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(d.key, img);
    for (const t of d.targets) paints.push([t, img]);
  }
  for (const [t, img] of paints) paint(t, img);
  if (queue.length) wake();
}
function wake() { if (!pumping) { pumping = true; requestAnimationFrame(pump); } }

const seen = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    seen.unobserve(en.target);
    const job = waiting.get(en.target);
    if (job) { queue.push(job); wake(); }
  }
}, { rootMargin: '200px' });

// once the visible tiles are done, fill in the rest of the page (hidden tiles wait until they are shown)
let idleTimer = 0;
function fillRest() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (queue.length) return fillRest(); voxAll(); }, 1200);
}
// queues every shown tile, in page order; a tab that just opened calls it so its lower tiles don't stay flat
export function voxAll() {
  for (const [t, job] of waiting) if (!t.isConnected) waiting.delete(t);
  for (const job of waiting.values()) if (job.target.isConnected && job.target.offsetParent && !queue.includes(job)) queue.push(job);
  if (queue.length) wake();
}

// target: the tile's .vox canvas; make(): returns ui.js composeLook(...), or null while its images load.
// Calling it again for the same canvas replaces the pending look (the picked character changed).
export function voxThumb(target, make) {
  if (!setup()) return false;
  waiting.set(target, { target, make, tries: 0 });
  seen.unobserve(target); seen.observe(target);
  fillRest();
  return true;
}
