// PixFray's own sprites rebuilt as voxels: every opaque pixel cell of a sprite frame becomes a small cube, two layers deep.
// A VoxelFighter flies its cubes in from scattered start points (assemble 0..1), and the cursor can push them aside.
import * as THREE from "three";
import { bevel } from "./bevel.js";

export async function loadImage(url) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

// Samples one sprite frame on a grid of `step` pixels. Returns cells { x, y, color } with the feet on y = 0, centred on x = 0.
export function sampleSprite(img, frame, step) {
  const c = document.createElement("canvas");
  c.width = frame.w;
  c.height = frame.h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  const d = g.getImageData(0, 0, frame.w, frame.h).data;
  const cols = Math.floor(frame.w / step),
    rows = Math.floor(frame.h / step),
    cells = [];
  for (let r = 0; r < rows; r++)
    for (let q = 0; q < cols; q++) {
      // the most opaque of the cell's centre pixel and its four neighbours, so thin outlines survive
      let best = -1,
        bi = 0;
      for (const [dx, dy] of [
        [0, 0],
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const x = Math.min(frame.w - 1, Math.max(0, Math.floor(q * step + step / 2) + dx)),
          y = Math.min(frame.h - 1, Math.max(0, Math.floor(r * step + step / 2) + dy));
        const i = (y * frame.w + x) * 4;
        if (d[i + 3] > best) {
          best = d[i + 3];
          bi = i;
        }
      }
      if (best < 150) continue;
      cells.push({
        q,
        r,
        color: new THREE.Color().setRGB(d[bi] / 255, d[bi + 1] / 255, d[bi + 2] / 255, THREE.SRGBColorSpace),
      });
    }
  if (!cells.length) return { cells, cols, rows: 0 };
  let minQ = Infinity,
    maxQ = -Infinity,
    maxR = -Infinity,
    minR = Infinity;
  for (const c of cells) {
    minQ = Math.min(minQ, c.q);
    maxQ = Math.max(maxQ, c.q);
    maxR = Math.max(maxR, c.r);
    minR = Math.min(minR, c.r);
  }
  const mid = (minQ + maxQ) / 2;
  for (const c of cells) {
    c.x = c.q - mid;
    c.y = maxR - c.r;
  }
  return { cells, cols: maxQ - minQ + 1, rows: maxR - minR + 1 };
}

const m4 = new THREE.Matrix4(),
  q4 = new THREE.Quaternion(),
  e3 = new THREE.Euler(),
  v3 = new THREE.Vector3(),
  s3 = new THREE.Vector3();
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export class VoxelFighter {
  // sprite: result of sampleSprite; size: cube edge in world units; layers: depth in cubes.
  constructor(sprite, { size = 0.07, layers = 2, scatter = "rain", seed = 1, shadows = false } = {}) {
    const cells = sprite.cells;
    this.size = size;
    this.height = sprite.rows * size;
    this.width = sprite.cols * size;
    // depth swells toward the middle of the sprite, so a fighter reads as a rounded figure, not a cut-out: edge cells are 2 deep, inner ones up to `layers`
    const key = (q, r) => q * 4096 + r,
      dist = new Map(cells.map((c) => [key(c.q, c.r), 0]));
    let ring = cells.filter((c) =>
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([a, b]) => !dist.has(key(c.q + a, c.r + b))),
    );
    for (const c of ring) dist.set(key(c.q, c.r), 1);
    for (let d = 2; ring.length && d < layers; d++) {
      const next = [];
      for (const c of ring)
        for (const [a, b] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const k = key(c.q + a, c.r + b);
          if (dist.get(k) === 0) {
            dist.set(k, d);
            next.push({ q: c.q + a, r: c.r + b });
          }
        }
      ring = next;
    }
    const depth = cells.map((c) => Math.min(layers, 2 * (dist.get(key(c.q, c.r)) || layers)));
    this.count = depth.reduce((a, b) => a + b, 0);
    const geo = new THREE.BoxGeometry(size * 0.94, size * 0.94, size * 0.94);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.04 });
    // a little self-light so the sprite colours read at night
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.16;",
      );
    };
    bevel(mat, [size * 0.47, size * 0.47, size * 0.47]);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.home = new Float32Array(this.count * 3);
    this.from = new Float32Array(this.count * 3);
    this.spin = new Float32Array(this.count * 3);
    this.delay = new Float32Array(this.count);
    this.push = new Float32Array(this.count * 3); // cursor displacement, eased
    this.rnd = new Float32Array(this.count);
    this.hurt = 0;
    this.hurtAt = { x: 0, y: 0 }; // damage 0..1 knocks cubes loose around a local impact point
    this.hurtDone = 0;
    let rnd = seed * 9301 + 49297;
    const rand = () => (rnd = (rnd * 9301 + 49297) % 233280) / 233280;
    let i = 0;
    cells.forEach((c, ci) => {
      const n = depth[ci];
      for (let l = 0; l < n; l++, i++) {
        const hx = c.x * size,
          hy = c.y * size + size / 2,
          hz = (l - (n - 1) / 2) * size;
        this.home.set([hx, hy, hz], i * 3);
        if (scatter === "rain")
          this.from.set([hx * 2.6 + (rand() - 0.5) * 3, hy + 5 + rand() * 6, hz + (rand() - 0.5) * 3], i * 3);
        else this.from.set([hx + (rand() - 0.5) * 5, hy + (rand() - 0.2) * 4, hz + (rand() - 0.5) * 5], i * 3);
        this.spin.set([(rand() - 0.5) * 9, (rand() - 0.5) * 9, (rand() - 0.5) * 9], i * 3);
        // feet first: lower cells land sooner, with some noise
        this.delay[i] = Math.min(1, (c.y / Math.max(1, sprite.rows)) * 0.7 + rand() * 0.3);
        this.rnd[i] = rand();
        // the front layer (+z, toward the camera) keeps the sprite colour, with a little per-cube grain; the back and sides go darker
        const col =
          l === n - 1
            ? c.color.clone().multiplyScalar(0.94 + 0.12 * this.rnd[i])
            : c.color.clone().multiplyScalar(0.55 + 0.3 * (l / Math.max(1, n - 1)));
        this.mesh.setColorAt(i, col);
      }
    });
    this.mesh.instanceColor.needsUpdate = true;
    this.assemble = -1;
    this.pointer = null; // local-space cursor point, or null
    this.settling = false;
    this.update(0, true);
  }

  // t: assembly 0..1. Writes instance matrices only when something moved.
  update(t, force = false) {
    t = Math.min(1, Math.max(0, t));
    const pointer = this.pointer;
    if (!force && t === this.assemble && !pointer && !this.settling && this.hurt === this.hurtDone) return;
    this.assemble = t;
    this.hurtDone = this.hurt;
    const R = this.height * 0.28,
      R2 = R * R;
    const hk = this.hurt,
      HR = this.height * (0.22 + 0.3 * hk),
      hx0 = this.hurtAt.x,
      hy0 = this.hurtAt.y;
    let moving = false;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      const a = easeOut(Math.min(1, Math.max(0, (t - this.delay[i] * 0.55) / 0.45)));
      let px = 0,
        py = 0,
        pz = 0;
      if (pointer && a === 1) {
        const dx = this.home[k] - pointer.x,
          dy = this.home[k + 1] - pointer.y,
          d2 = dx * dx + dy * dy;
        if (d2 < R2) {
          const d = Math.sqrt(d2) || 1e-4,
            f = Math.pow(1 - d / R, 2) * this.height * 0.22;
          px = (dx / d) * f;
          py = (dy / d) * f;
          pz = f * 1.4 * (this.home[k + 2] >= 0 ? 1 : 0.6);
        }
      }
      let ex = this.push[k] + (px - this.push[k]) * 0.16,
        ey = this.push[k + 1] + (py - this.push[k + 1]) * 0.16,
        ez = this.push[k + 2] + (pz - this.push[k + 2]) * 0.16;
      this.push[k] = ex;
      this.push[k + 1] = ey;
      this.push[k + 2] = ez;
      if (Math.abs(ex) + Math.abs(ey) + Math.abs(ez) > 1e-4) moving = true;
      if (a <= 0) {
        m4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, m4);
        continue;
      }
      let knock = 0;
      if (hk > 0 && a === 1) {
        // cubes near the impact break off and hang in the air, away from the blow
        const dx = this.home[k] - hx0,
          dy = this.home[k + 1] - hy0,
          d = Math.hypot(dx, dy);
        if (d < HR && this.rnd[i] < hk * 0.75 * (1 - d / HR)) {
          knock = (0.5 + this.rnd[i] * 2.2) * this.size * 12 * hk;
          const n = d || 1e-4;
          ex += knock * (0.35 + 0.4 * this.rnd[(i * 3) % this.count]);
          ey += (dy / n) * knock * 0.45 + knock * 0.1;
          ez += knock * (0.5 + this.rnd[(i * 7) % this.count]);
        }
      }
      v3.set(
        this.from[k] + (this.home[k] - this.from[k]) * a + ex,
        this.from[k + 1] + (this.home[k + 1] - this.from[k + 1]) * a + ey,
        this.from[k + 2] + (this.home[k + 2] - this.from[k + 2]) * a + ez,
      );
      const r = 1 - a,
        sc = a < 1 ? 0.18 + 0.82 * a * a : 1;
      if (r > 0 || ez > 0.002) {
        e3.set(this.spin[k] * r + ez * 6, this.spin[k + 1] * r, this.spin[k + 2] * r);
        q4.setFromEuler(e3);
      } else q4.identity();
      s3.setScalar(sc);
      m4.compose(v3, q4, s3);
      this.mesh.setMatrixAt(i, m4);
    }
    this.settling = moving;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = t > 0;
  }
}
