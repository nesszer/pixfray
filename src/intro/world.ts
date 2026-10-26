// The night arena of the home page tour and the fighter stage. Everything is instanced boxes, so the scene stays light.
import * as THREE from "three";
import { bevel } from "./bevel.ts";

type Uniforms<T> = { [K in keyof T]: THREE.IUniform<T[K]> };
type ShaderMaterialOf<T> = THREE.ShaderMaterial & { uniforms: Uniforms<T> };
// additive light (beams, the duel circle, embers): no depth write, so it never hides what is behind it
export const glow = <T>(
  uniforms: Uniforms<T>,
  vertexShader: string,
  fragmentShader: string,
  side: THREE.Side = THREE.FrontSide,
) =>
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side,
    uniforms,
    vertexShader,
    fragmentShader,
  }) as ShaderMaterialOf<T>; // the uniforms passed in
type RGB = [number, number, number];
type Vec3 = [number, number, number];
export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;
type SkyMaterial = ShaderMaterialOf<{ uTime: number; uMoon: number; uMul: THREE.Vector3 }>;
type CloudMaterial = ShaderMaterialOf<{
  uTime: number;
  uDeep: THREE.Color;
  uLit: THREE.Color;
  uA: number;
  uS: number;
  uV: number;
}>;
type HoardColumn = { x: number; z: number; h: number; gem: RGB | null; s: number };

// A baked night for reflections (shared with the fighter stage): brass, gold, the ring and the wet floor pick it up.
export function bakeNightEnv(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const env = new THREE.Scene(),
    cube = new THREE.BoxGeometry(1, 1, 1);
  env.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(20, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x1a120c, side: THREE.BackSide }),
    ),
  );
  const panel = (c: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const m = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ color: c }));
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    env.add(m);
  };
  panel(0xd8d0c4, 0, 12, -14, 4, 4, 1); // moon
  panel(0x6a4a30, 0, -10, 0, 30, 1, 30); // warm floor bounce
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    panel(0xffa040, Math.cos(a) * 9, 2, Math.sin(a) * 9, 1.4, 2.4, 1.4);
  }
  panel(0x3a4a7a, -16, 6, 4, 1, 10, 14); // cool fill side
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

// Shared with the fighter stage. A cool fill against the warm lanterns makes two-tone cubes read as solid.
export function addNightLights(
  scene: THREE.Scene,
  o: { hemi: number; cool: number; key: number; rim: number; shadowMap: number; shadowBox: object },
) {
  const hemi = new THREE.HemisphereLight(0x8a6a4a, 0x120c08, o.hemi);
  const cool = new THREE.DirectionalLight(0x5d7cff, o.cool);
  cool.position.set(-6, 1.6, 1.5);
  const key = new THREE.DirectionalLight(0xffcf96, o.key);
  key.position.set(4.5, 7.5, 5.5);
  key.shadow.mapSize.set(o.shadowMap, o.shadowMap);
  Object.assign(key.shadow.camera, { ...o.shadowBox, near: 1, far: 22 });
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  const rim = new THREE.DirectionalLight(0x9db2ff, o.rim);
  rim.position.set(-1.5, 10, -8);
  scene.add(hemi, cool, key, rim);
  const warm = (
    [
      [-3.2, 1.9, 2.6],
      [3.3, 1.9, 2.2],
      [0.2, 1.9, -3.6],
    ] satisfies [number, number, number][]
  ).map(([x, y, z]) => {
    const l = new THREE.PointLight(0xff9a40, 16, 10, 2);
    l.position.set(x, y, z);
    scene.add(l);
    return l;
  });
  return { hemi, cool, key, rim, warm };
}

const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x: number, y: number) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi),
    b = hash(xi + 1, yi),
    c = hash(xi, yi + 1),
    d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number) =>
  vnoise(x, y) * 0.6 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.1;

// the same value noise in GLSL: nh is the hash, vn the smoothed noise
const NOISE = `float nh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(nh(i), nh(i + vec2(1., 0.)), f.x), mix(nh(i + vec2(0., 1.)), nh(i + vec2(1., 1.)), f.x), f.y); }`;

// GLSL added after three's own shader chunks, by chunk name: after(src, { common: "...", color_fragment: "..." })
const after = (src: string, chunks: Record<string, string>) =>
  Object.entries(chunks).reduce((out, [k, code]) => out.replace(`#include <${k}>`, `#include <${k}>\n${code}`), src);
function box<M extends THREE.Material>(parent: THREE.Object3D, mat: M, [w, h, d]: Vec3, [x, y, z]: Vec3) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
// an open cylinder of additive light (the rank 1 beam, the chest's shaft): uA fades it, uTime moves its bands
export const lightShaft = (geo: THREE.CylinderGeometry, vertexShader: string, fragmentShader: string) =>
  new THREE.Mesh(geo, glow({ uA: { value: 0 }, uTime: { value: 0 } }, vertexShader, fragmentShader, THREE.DoubleSide));
const FLAME = { color: 0x000000, emissive: 0xff8a2a, emissiveIntensity: 1.8 };

const RING_R0 = 3.3,
  RING_R1 = 3.62;
const m4 = new THREE.Matrix4(),
  col = new THREE.Color();

export function buildSky(): THREE.Mesh<THREE.SphereGeometry, SkyMaterial> {
  const geo = new THREE.SphereGeometry(80, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 }, uMoon: { value: 1 }, uMul: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `
      varying vec3 vDir; uniform float uTime, uMoon; uniform vec3 uMul;
      ${NOISE}
      float fb(vec2 p){ return vn(p) * .55 + vn(p * 2.07 + 3.1) * .3 + vn(p * 4.3 + 7.7) * .15; }
      float ridge(float a, float k, float px){ float q = floor(a * px) / px; float r = fb(vec2(q * 3.0 + k, k));
        return (pow(max(r - 0.32, 0.0), 1.6) * 0.55 + 0.004) * step(0.3, vn(vec2(q * 1.2 + k * 3.0, 1.0)) + 0.25); }
      void main(){
        float y = vDir.y;
        vec3 low = vec3(0.105, 0.064, 0.036), mid = vec3(0.043, 0.030, 0.022), top = vec3(0.016, 0.013, 0.012);
        vec3 c = mix(low, mid, smoothstep(-0.25, 0.18, y));
        c = mix(c, top, smoothstep(0.18, 0.75, y));
        c += vec3(0.09, 0.045, 0.015) * exp(-(y + 0.02) * (y + 0.02) * 49.0) * 0.55;
        c *= uMul;   // the chapter's mood
        float az = atan(vDir.z, vDir.x);
        vec2 cp = floor(vec2(az * 120.0, y * 120.0)) / 120.0;
        float cl = smoothstep(0.52, 0.78, fb(vec2(cp.x * 2.2 + uTime * 0.004, cp.y * 9.0))) * smoothstep(0.04, 0.16, y) * (1.0 - smoothstep(0.42, 0.62, y));
        float moonSide = 0.55 + 0.45 * smoothstep(-0.6, 0.9, dot(normalize(vDir.xz), normalize(vec2(-0.06, -0.98))));
        c = mix(c, (vec3(0.16, 0.12, 0.09) * moonSide + vec3(0.03)) * uMul * 0.9, cl * 0.42);
        float r1 = ridge(az, 2.0, 90.0), r2 = ridge(az + 0.7, 9.0, 55.0) * 0.8;
        vec3 haze = (vec3(0.13, 0.08, 0.05) + vec3(0.09, 0.045, 0.015) * 0.5) * uMul;
        float yq = floor(y * 120.0) / 120.0;
        if (y < 0.0) {
          vec2 sp = vDir.xz / max(-y, 0.025);                 // the cloud deck as a plane far below
          vec2 sq = floor(sp * 5.0) / 5.0;
          float sea = smoothstep(0.4, 0.74, fb(sq * 0.22 + vec2(uTime * 0.006, 0.0)));
          float lit = smoothstep(0.55, 0.85, fb(sq * 0.22 + vec2(uTime * 0.006, 0.0) + vec2(0.05, 0.08)));   // tops facing the moon
          vec3 deck = mix(haze * 0.3, (vec3(0.2, 0.15, 0.11) * moonSide + vec3(0.04, 0.03, 0.025)) * uMul, sea);
          deck += vec3(0.1, 0.085, 0.065) * uMul * uMoon * sea * (1.0 - lit) * moonSide;
          c = mix(deck, haze * 0.82, exp(y * 14.0));         // fades into the horizon haze
        }
        if (yq < r1 && y > -0.004) c = mix(haze * 0.82, c, 0.25);
        if (yq < r2 && y > -0.004) { c = haze * 0.42; if (yq > r2 - 1.5 / 120.0) c += vec3(0.07, 0.06, 0.05) * uMul; }
        vec2 g = vec2(atan(vDir.z, vDir.x) * 160.0, asin(clamp(y, -1., 1.)) * 160.0);
        vec2 cell = floor(g); float s = nh(cell);
        float star = step(0.9965, s) * step(0.12, y) * (0.55 + 0.45 * sin(uTime * (0.6 + s * 3.0) + s * 40.0));
        c += vec3(0.95, 0.85, 0.65) * star * 0.55 * smoothstep(0.12, 0.4, y);
        // a big pixel moon behind the arena: a disc drawn on a 15x15 grid, with darker 'craters' and a soft halo
        vec3 md = normalize(vec3(-0.06, 0.17, -0.98));
        vec3 mx = normalize(cross(md, vec3(0., 1., 0.))), my = cross(mx, md);
        float front = step(0., dot(vDir, md));
        vec2 uv = vec2(dot(vDir, mx), dot(vDir, my)) / 0.05;
        vec2 px = floor(uv * 7.5);
        float disc = step(length((px + 0.5) / 7.5), 1.0) * front * uMoon;
        vec2 pc = (px + 0.5) / 7.5; float pr = length(pc);
        float crater = step(0.62, nh(floor(px / 3.0) + 7.0)) * step(0.4, nh(px + 3.0));
        float shade = 0.9 + 0.1 * nh(px + 11.0) - 0.22 * crater;
        shade *= mix(1.0, 0.55, smoothstep(-0.2, 0.9, dot(pc, normalize(vec2(1.0, -0.8)))));   // lit from the upper left
        shade += 0.22 * step(0.82, pr) * step(0.2, dot(pc, normalize(vec2(-1.0, 0.8))));   // bright rim
        c = mix(c, vec3(0.78, 0.72, 0.62) * shade, disc);
        float halo = exp(-max(0., length(uv) - 1.0) * 1.8) * 0.16 + exp(-max(0., length(uv) - 1.0) * 0.4) * 0.05;
        c += vec3(0.62, 0.5, 0.36) * halo * front * uMoon * (1.0 - disc);
        float ang = floor(atan(uv.y, uv.x) * 40.0) / 40.0, lr = length(uv);
        float rays = smoothstep(0.45, 0.8, vn(vec2(ang * 7.0, uTime * 0.03))) * exp(-max(0., lr - 1.0) * 0.22) * step(1.0, lr);
        c += vec3(0.55, 0.45, 0.32) * rays * 0.07 * front * uMoon * (0.6 + cl);
        gl_FragColor = vec4(c, 1.);
      }`,
  }) as SkyMaterial; // the uniforms passed above
  return new THREE.Mesh(geo, mat);
}

// The island: one column per grid cell; the bodies hang below and taper with noise so the island floats.
export function buildIsland({
  radius = 7.2,
  cell = 0.34,
  shadows = false,
}: { radius?: number; cell?: number; shadows?: boolean } = {}): THREE.Group {
  type Column = { x: number; z: number; y: number; color: RGB };
  const nonRing: Column[] = [],
    ring: Column[] = [],
    bodies: { x: number; z: number; top: number; bottom: number }[] = [];
  const n = Math.ceil(radius / cell);
  for (let gx = -n; gx <= n; gx++)
    for (let gz = -n; gz <= n; gz++) {
      const x = gx * cell,
        z = gz * cell,
        r = Math.hypot(x, z);
      const edge = radius * (0.86 + fbm(x * 0.35 + 9, z * 0.35) * 0.28);
      if (r > edge) continue;
      let topY: number,
        color: RGB,
        tops = nonRing;
      if (r < RING_R0) {
        const board = Math.floor((x + 20) / (cell * 2)),
          plank = board % 2,
          run = Math.floor((z + 20 + hash(board, 1) * 3) / (cell * 5));
        const shade = hash(board * 3, run) * 0.07 + hash(gx, gz) * 0.03,
          wear = Math.max(0, 1 - r / 2.2) * 0.05; // the centre is scuffed lighter
        color = plank
          ? [0.27 + shade + wear, 0.18 + (shade + wear) * 0.7, 0.11 + wear * 0.4]
          : [0.22 + shade + wear, 0.145 + (shade + wear) * 0.7, 0.088 + wear * 0.4];
        topY = (hash(board * 7, run * 3) - 0.5) * 0.02;
        if (Math.abs(r - 2.66) < cell * 0.55) {
          topY = -0.01;
          color = [0.12, 0.075, 0.045];
        } // the groove the glowing circle sits in
      } else if (r < RING_R1) {
        color = [0.79, 0.62, 0.33];
        topY = 0.05;
        tops = ring;
      } else {
        const h = fbm(x * 0.55, z * 0.55),
          rise = Math.min(1, (r - RING_R1) / 1.6);
        topY = Math.round(((h - 0.35) * 1.1 * rise + rise * 0.12) / (cell * 0.5)) * cell * 0.5;
        const s = 0.12 + h * 0.08 + hash(gx * 3, gz) * 0.03;
        color = [s * 1.05, s * 0.9, s * 0.78];
        if (hash(gx, gz * 7) > 0.93) color = [0.17, 0.2, 0.12]; // a little moss
      }
      const depth = 0.8 + Math.pow(Math.max(0, 1 - r / radius), 0.8) * 5.2 * (0.7 + fbm(x * 0.8 + 3, z * 0.8) * 0.6);
      tops.push({ x, z, y: topY, color });
      bodies.push({ x, z, top: topY - cell * 0.5, bottom: topY - depth });
    }
  const group = new THREE.Group();
  const capH = cell * 0.5;
  const boxGeo = new THREE.BoxGeometry(cell * 0.985, 1, cell * 0.985);
  const topMat = new THREE.MeshStandardMaterial({ roughness: 0.66, metalness: 0.0 });
  const floorTint = { value: new THREE.Color(1, 1, 1) }; // each chapter re-tints the stone
  topMat.onBeforeCompile = (sh) => {
    sh.uniforms.uFloor = floorTint;
    sh.vertexShader = after(sh.vertexShader, {
      common: "varying vec3 vWp; varying float vUp;",
      worldpos_vertex: " vWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz; vUp = normal.y;",
    });
    sh.fragmentShader = after(sh.fragmentShader, {
      common: `
      varying vec3 vWp; varying float vUp; uniform vec3 uFloor;
      ${NOISE}`,
      color_fragment: `
        float rr = length(vWp.xz), onFloor = step(rr, ${RING_R0.toFixed(2)}) * step(0.5, vUp);
        float grain = vn(vec2(vWp.x * 26.0, vWp.z * 2.2)) * 0.7 + vn(vec2(vWp.x * 70.0, vWp.z * 5.0)) * 0.3;
        diffuseColor.rgb *= mix(1.0, 0.8 + 0.34 * grain, onFloor) * mix(vec3(1.0), uFloor, step(0.5, vUp));`,
      roughnessmap_fragment: `
        float wet = smoothstep(0.6, 0.76, vn(vWp.xz * 0.9 + 4.0) * 0.7 + vn(vWp.xz * 3.1) * 0.3) * step(0.5, vUp);
        roughnessFactor = mix(roughnessFactor, 0.2, wet);`,
    });
  };
  const ringMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.85, color: 0xffffff });
  const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
  bodyMat.onBeforeCompile = (sh) => {
    sh.vertexShader = after(sh.vertexShader, {
      common: "varying vec3 vWp;",
      worldpos_vertex: " vWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;",
    });
    sh.fragmentShader = after(sh.fragmentShader, {
      common: `
      varying vec3 vWp;
      ${NOISE}`,
      color_fragment: `
        vec3 wq = floor(vWp / ${(cell * 0.5).toFixed(3)}) * ${(cell * 0.5).toFixed(3)};
        float band = floor(wq.y / ${(cell * 1.5).toFixed(3)});
        diffuseColor.rgb *= 0.9 + 0.8 * nh(vec2(band, 3.0)) + 0.25 * vn(wq.xz * 1.3);`,
      emissivemap_fragment: `
        float va = atan(wq.z, wq.x) * 4.0, vein = abs(vn(vec2(va, wq.y * 0.9)) - 0.5);
        float glow = (1.0 - smoothstep(0.0, 0.035, vein)) * smoothstep(0.2, -1.2, wq.y);
        totalEmissiveRadiance += vec3(1.0, 0.42, 0.1) * glow * 2.4 + diffuseColor.rgb * 0.12 * smoothstep(0.0, -2.0, wq.y);`,
    });
  };
  for (const m of [topMat, ringMat, bodyMat]) bevel(m, [cell * 0.4925, 0.5, cell * 0.4925]);
  // one instanced column per item: fn gives its centre height, its height and its colour
  const make = <T extends { x: number; z: number }>(
    list: T[],
    mat: THREE.MeshStandardMaterial,
    fn: (it: T, i: number) => [number, number, RGB],
  ) => {
    const mesh = new THREE.InstancedMesh(boxGeo, mat, list.length);
    list.forEach((it, i) => {
      const [y, h, rgb] = fn(it, i);
      mesh.setMatrixAt(i, m4.makeScale(1, h, 1).setPosition(it.x, y, it.z));
      mesh.setColorAt(i, col.setRGB(...rgb, THREE.SRGBColorSpace));
    });
    mesh.receiveShadow = shadows;
    return mesh;
  };
  group.add(make(nonRing, topMat, (t) => [t.y - capH / 2, capH, t.color]));
  group.add(make(ring, ringMat, (t, i) => [t.y - capH / 2, capH, [0.8 + hash(i, 2) * 0.1, 0.6, 0.3]]));
  // the duel circle: drawn in fine pixels (8 per floor cell) on a flat disc, so it stays a clean circle at any angle
  const rune = { uI: { value: 0.9 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0xff7a26) } };
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(3.05, 72).rotateX(-Math.PI / 2),
    glow(
      rune,
      "varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }",
      `uniform float uI, uTime; uniform vec3 uColor; varying vec2 vP;
      void main(){
        vec2 q = (floor(vP / 0.0425) + 0.5) * 0.0425;
        float r = length(q), a = atan(q.y, q.x) / 6.28318;
        float line = step(abs(r - 2.66), 0.035);
        float inner = step(abs(r - 2.38), 0.022) * step(0.45, fract(a * 48.0));
        float ticks = step(abs(r - 2.52), 0.09) * step(0.93, fract(a * 12.0 + 0.035));
        float pulse = 0.8 + 0.2 * sin(a * 18.85 - uTime * 1.4);
        gl_FragColor = vec4(uColor * (line + inner * 0.45 + ticks * 0.75) * uI * pulse, 1.0);
      }`,
    ),
  );
  disc.position.y = 0.006;
  disc.renderOrder = 1;
  group.add(disc);
  group.userData.rune = rune;
  group.userData.floor = floorTint;
  const body = make(bodies, bodyMat, (b, i) => {
    const h = b.top - b.bottom,
      s = 0.085 + hash(i, 5) * 0.035;
    return [b.bottom + h / 2, h, [s * 1.08, s * 0.9, s * 0.76]];
  });
  body.receiveShadow = false;
  group.add(body);
  return group;
}

export function buildLanterns({ count = 8, radius = 3.95 }: { count?: number; radius?: number } = {}) {
  const group = new THREE.Group(),
    flames: { mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>; seed: number }[] = [];
  const wood = new THREE.MeshStandardMaterial({ color: 0x2b1d12, roughness: 0.9 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a45c, roughness: 0.35, metalness: 0.9 });
  bevel(wood, [0.07, 0.75, 0.07]);
  const coneGeo = new THREE.CylinderGeometry(0.1, 0.95, 1.62, 28, 1, true);
  const cone = glow(
    { uColor: { value: new THREE.Color(0xff9a40) }, uA: { value: 0.16 } },
    `varying float vY; varying vec3 vN, vV;
      void main(){ vY = position.y / 1.62 + 0.5; vec4 mv = modelViewMatrix * vec4(position, 1.); vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    `uniform vec3 uColor; uniform float uA; varying float vY; varying vec3 vN, vV;
      void main(){ float f = abs(dot(normalize(vN), normalize(vV))); float a = f * f * smoothstep(0.0, 0.3, vY) * (0.35 + 0.65 * vY); gl_FragColor = vec4(uColor * a * uA, 1.0); }`,
    THREE.DoubleSide,
  );
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI / count;
    const x = Math.sin(a) * radius,
      z = Math.cos(a) * radius;
    if (z > radius * 0.8) continue; // keep the camera side open
    box(group, wood, [0.14, 1.5, 0.14], [x, 0.75, z]);
    box(group, brass, [0.34, 0.06, 0.34], [x, 1.86, z]);
    box(group, brass, [0.3, 0.06, 0.3], [x, 1.52, z]);
    const flame = box(group, new THREE.MeshStandardMaterial(FLAME), [0.17, 0.24, 0.17], [x, 1.69, z]);
    const beam = new THREE.Mesh(coneGeo, cone);
    beam.position.set(x, 1.6 - 0.81, z);
    beam.renderOrder = 2;
    group.add(beam);
    flames.push({ mesh: flame, seed: i * 1.7 });
  }
  return { group, flames, cone };
}

// Embers drifting up from the arena: points whose motion lives entirely in the vertex shader.
export function buildEmbers(count = 900) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3),
    seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2,
      r = Math.sqrt(Math.random()) * 7.5;
    pos.set([Math.cos(a) * r, Math.random() * 9 - 1, Math.sin(a) * r], i * 3);
    seed[i] = Math.random();
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  const mat = glow(
    { uTime: { value: 0 }, uPx: { value: 1 }, uBurst: { value: 0 } },
    `
      attribute float seed; uniform float uTime, uPx, uBurst; varying float vA; varying float vS;
      void main(){
        vec3 p = position;
        float t = uTime * (0.18 + seed * 0.22) + seed * 10.0;
        p.y = mod(p.y + t, 10.0) - 1.5;
        p.x += sin(t * 1.3 + seed * 20.0) * 0.35; p.z += cos(t * 1.1 + seed * 13.0) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float life = smoothstep(-1.5, 0.5, p.y) * (1.0 - smoothstep(5.5, 8.5, p.y));
        float near = smoothstep(1.5, 3.5, -mv.z);   // an ember drifting past the lens would fill a big square
        vA = life * near * (0.35 + 0.65 * fract(seed * 7.13)) * (1.0 + uBurst);
        vS = seed;
        gl_PointSize = min((1.6 + seed * 2.6) * uPx * (8.0 / -mv.z), 9.0 * uPx);
      }`,
    `
      varying float vA; varying float vS;
      void main(){
        vec2 d = abs(gl_PointCoord - 0.5);
        if (max(d.x, d.y) > 0.5) discard;   // square embers, like pixels
        vec3 c = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.78, 0.42), vS);
        gl_FragColor = vec4(c * 1.6, vA);
      }`,
  );
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

export function buildIslets() {
  const group = new THREE.Group(),
    list: { g: THREE.Group; y: number; seed: number }[] = [];
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = after(sh.fragmentShader, {
      emissivemap_fragment: " totalEmissiveRadiance += diffuseColor.rgb * 0.22;",
    });
  };
  const lampMat = new THREE.MeshStandardMaterial(FLAME);
  const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  bevel(mat, [0.15, 0.15, 0.15]);
  const spots: [number, number, number, number][] = [
    [-9, 1.5, -6, 5],
    [10, -1, -8, 6],
    [-12, -3, 2, 4],
    [8.5, 3, -14, 5],
    [-6, 4.5, -15, 4],
    [13, 0.5, 3, 3],
  ];
  for (const [x, y, z, n] of spots) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const cols: { a: number; b: number; d: number; top: number }[] = [];
    for (let a = -n; a <= n; a++)
      for (let b = -n; b <= n; b++) {
        const r = Math.hypot(a, b) / n;
        if (r > 1) continue;
        cols.push({
          a,
          b,
          d: Math.round((1 - r) * n * 0.9 * (0.6 + hash(a + x, b + z) * 0.8)) + 1,
          top: Math.round(hash(a * 3 + x, b - z) * 1.3) * 0.15,
        });
      }
    const mesh = new THREE.InstancedMesh(geo, mat, cols.length * 2);
    let i = 0;
    let deep = cols[0]!; // the centre column (r = 0) is always in the list
    for (const c of cols) {
      mesh.setMatrixAt(i, m4.makeScale(1, c.d, 1).setPosition(c.a * 0.3, c.top - c.d * 0.15 - 0.075, c.b * 0.3));
      const s = 0.13 + hash(c.a, c.b + x) * 0.05;
      mesh.setColorAt(i++, col.setRGB(s * 1.1, s * 0.9, s * 0.74, THREE.SRGBColorSpace));
      mesh.setMatrixAt(i, m4.makeScale(1, 0.5, 1).setPosition(c.a * 0.3, c.top, c.b * 0.3));
      const moss = hash(c.a + 9, c.b * 2 + z) > 0.4;
      mesh.setColorAt(i++, col.setRGB(moss ? 0.24 : 0.36, 0.3, moss ? 0.15 : 0.22, THREE.SRGBColorSpace));
      if (c.d > deep.d) deep = c;
    }
    g.add(mesh);
    const lamp = box(g, lampMat, [0.2, 0.26, 0.2], [deep.a * 0.3, deep.top - deep.d * 0.3 - 0.35, deep.b * 0.3]);
    box(g, mat, [0.03, 0.2, 0.03], [lamp.position.x, lamp.position.y + 0.23, lamp.position.z]);
    group.add(g);
    list.push({ g, y, seed: x * 0.37 });
  }
  return { group, list };
}

// A voxel d6: a 5x5x5 block with its pips in dark inlay; FACE_UP turns a value to the top.
export function buildDie(unit = 0.14): THREE.Group {
  const N = 5,
    half = (N - 1) / 2,
    cubes: { x: number; y: number; z: number; pip: boolean }[] = [];
  // each face's 3x3 centre, row by row: o is a pip
  const PIPS: Record<DieValue, string> = {
    1: "....o....",
    2: "o.......o",
    3: "o...o...o",
    4: "o.o...o.o",
    5: "o.o.o.o.o",
    6: "o.oo.oo.o",
  };
  // face normal -> value (opposite faces add up to 7)
  const faces: [RGB, DieValue][] = [
    [[0, 1, 0], 6],
    [[0, -1, 0], 1],
    [[1, 0, 0], 3],
    [[-1, 0, 0], 4],
    [[0, 0, 1], 5],
    [[0, 0, -1], 2],
  ];
  const isPip = (x: number, y: number, z: number) =>
    faces.some(([[nx, ny, nz], v]) => {
      const onFace = (nx && x === nx * half) || (ny && y === ny * half) || (nz && z === nz * half);
      const [u, w] = nx ? [z, y] : ny ? [x, z] : [x, y];
      return onFace && Math.abs(u) < 2 && Math.abs(w) < 2 && PIPS[v][(w + 1) * 3 + u + 1] === "o";
    });
  for (let x = -half; x <= half; x++)
    for (let y = -half; y <= half; y++)
      for (let z = -half; z <= half; z++) {
        const outer = [x, y, z].filter((c) => Math.abs(c) === half).length;
        // the shell only, without its corners (a rounded look)
        if (outer === 1 || outer === 2) cubes.push({ x, y, z, pip: isPip(x, y, z) });
      }
  const geo = new THREE.BoxGeometry(unit * 0.96, unit * 0.96, unit * 0.96);
  const bone = new THREE.MeshStandardMaterial({ color: 0xefe3c8, roughness: 0.45 });
  const pip = new THREE.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 0.6 });
  bevel(bone, [unit * 0.48, unit * 0.48, unit * 0.48]);
  const body = new THREE.InstancedMesh(geo, bone, cubes.filter((c) => !c.pip).length);
  const pips = new THREE.InstancedMesh(geo, pip, cubes.filter((c) => c.pip).length);
  let a = 0,
    b = 0;
  for (const c of cubes) {
    m4.makeTranslation(c.x * unit, c.y * unit, c.z * unit);
    if (c.pip) pips.setMatrixAt(b++, m4);
    else body.setMatrixAt(a++, m4);
  }
  const group = new THREE.Group();
  group.add(body, pips);
  body.castShadow = true;
  return group;
}
// Rotation (Euler XYZ) that turns the face with this value to the top.
export const FACE_UP: Record<DieValue, [number, number, number]> = {
  6: [0, 0, 0],
  1: [Math.PI, 0, 0],
  3: [0, 0, Math.PI / 2],
  4: [0, 0, -Math.PI / 2],
  5: [-Math.PI / 2, 0, 0],
  2: [Math.PI / 2, 0, 0],
};

// Podium columns for the ladder: one instanced mesh, heights set per frame.
export function buildPodium(count = 5, cell = 0.3) {
  const geo = new THREE.BoxGeometry(cell * 0.96, cell * 0.96, cell * 0.96);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.12 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = after(sh.vertexShader, {
      common: "varying vec3 vPid;",
      begin_vertex: `
        vPid = vec3(0.0);
        #ifdef USE_INSTANCING
          vPid = instanceMatrix[3].xyz;
        #endif`,
    });
    sh.fragmentShader = after(sh.fragmentShader, {
      common: "varying vec3 vPid;",
      emissivemap_fragment: `
        totalEmissiveRadiance += diffuseColor.rgb * (smoothstep(0.3, 0.6, diffuseColor.r) * 0.6 + 0.3);
        {
          float stone = 1.0 - smoothstep(0.26, 0.4, diffuseColor.r);
          vec3 an = abs(vNo);
          vec2 fuv = (an.x > 0.5 ? vLp.zy : an.y > 0.5 ? vLp.xz : vLp.xy) / (2.0 * uHalf.x) + 0.5;
          vec3 cid = floor(vPid * ${(2 / cell).toFixed(4)} + 0.5) + vNo * 7.0;
          float pick = fract(sin(dot(cid, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          vec2 g = floor(fuv * 5.0), fc = fract(fuv * 5.0);
          float bit = fract(sin(dot(g + cid.xy * 3.1 + cid.z, vec2(27.17, 91.31))) * 15731.743);
          float inner = step(1.0, g.x) * step(g.x, 3.0) * step(1.0, g.y) * step(g.y, 3.0);
          float pix = step(0.16, fc.x) * step(fc.x, 0.84) * step(0.16, fc.y) * step(fc.y, 0.84);
          float glyph = stone * step(0.6, pick) * inner * step(0.42, bit) * pix * (1.0 - an.y);
          totalEmissiveRadiance += vec3(1.0, 0.42, 0.1) * glyph * (1.2 + 1.2 * fract(pick * 7.3));
          float edge = 1.0 - smoothstep(0.0, 0.06, 0.5 - max(abs(fuv.x - 0.5), abs(fuv.y - 0.5)));
          totalEmissiveRadiance += vec3(0.34, 0.42, 0.62) * edge * stone * 0.35;
        }`,
    });
  };
  bevel(mat, [cell * 0.48, cell * 0.48, cell * 0.48]);
  const mesh = new THREE.InstancedMesh(geo, mat, count * 18 * 4); // up to 18 levels of 2x2 cubes per column
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return { mesh, cell };
}

export function buildCoins(count = 40, unit = 0.05) {
  const disc: [number, number][] = [];
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) if (a * a + b * b <= 5) disc.push([a, b]);
  const geo = new THREE.BoxGeometry(unit * 0.95, unit * 0.95, unit * 0.95);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf0c060,
    metalness: 0.35,
    roughness: 0.35,
    emissive: 0xb07818,
    emissiveIntensity: 0.9,
  });
  bevel(mat, [unit * 0.475, unit * 0.475, unit * 0.475]);
  const mesh = new THREE.InstancedMesh(geo, mat, count * disc.length);
  mesh.frustumCulled = false;
  return { mesh, disc, unit, count };
}

export function buildClouds() {
  const group = new THREE.Group(),
    mats: CloudMaterial[] = [];
  for (const [y, scale, speed, a] of [
    [-5.2, 0.05, 0.6, 0.9],
    [-3.4, 0.08, 1.0, 0.55],
  ] satisfies [number, number, number, number][]) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x0d0906) },
        uLit: { value: new THREE.Color(0x7a5a3a) },
        uA: { value: a },
        uS: { value: scale },
        uV: { value: speed },
      },
      vertexShader:
        "varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: `uniform float uTime, uA, uS, uV; uniform vec3 uDeep, uLit; varying vec3 vW;
        ${NOISE}
        void main(){
          vec2 p = vW.xz * uS + vec2(uTime * 0.012 * uV, uTime * 0.006 * uV);
          float d = vn(p) * 0.5 + vn(p * 2.1 + 3.7) * 0.28 + vn(p * 4.3 - 1.3) * 0.14 + vn(p * 8.9) * 0.08;
          float dens = smoothstep(0.38, 0.78, d);
          float far = length(vW.xz - cameraPosition.xz);
          float a = dens * uA * (1.0 - smoothstep(38.0, 90.0, far));
          vec3 c = mix(uDeep, uLit, smoothstep(0.45, 0.95, d));
          gl_FragColor = vec4(c, a);
        }`,
    }) as CloudMaterial; // the uniforms passed above
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), mat);
    plane.position.y = y;
    plane.renderOrder = -1;
    group.add(plane);
    mats.push(mat);
  }
  return { group, mats };
}

export function buildChest() {
  const group = new THREE.Group(),
    lid = new THREE.Group();
  const wood = bevel(new THREE.MeshStandardMaterial({ color: 0x5a3519, roughness: 0.8 }), [0.7, 0.3, 0.42], 0.6);
  const brass = bevel(
    new THREE.MeshStandardMaterial({ color: 0xd8ae5a, roughness: 0.3, metalness: 0.9 }),
    [0.72, 0.05, 0.44],
    0.6,
  );
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xffd27a,
    emissive: 0xffa632,
    emissiveIntensity: 1.6,
    roughness: 0.3,
    metalness: 0.5,
  });
  box(group, wood, [1.4, 0.6, 0.84], [0, 0.3, 0]);
  for (const x of [-0.5, 0.5]) box(group, brass, [0.12, 0.62, 0.86], [x, 0.3, 0]);
  box(group, brass, [1.42, 0.08, 0.86], [0, 0.62, 0]);
  box(group, goldMat, [1.3, 0.06, 0.74], [0, 0.6, 0]);
  for (let i = 0; i < 14; i++) {
    const h = 0.08 + hash(i, 3) * 0.08;
    box(group, goldMat, [0.12, h, 0.12], [(hash(i, 1) - 0.5) * 1.1, 0.64, (hash(i, 2) - 0.5) * 0.6]);
  }
  lid.position.set(0, 0.66, -0.42);
  box(lid, wood, [1.4, 0.24, 0.84], [0, 0.12, 0.42]);
  for (const x of [-0.5, 0.5]) box(lid, brass, [0.12, 0.26, 0.86], [x, 0.12, 0.42]);
  box(lid, brass, [0.16, 0.18, 0.06], [0, 0, 0.86]); // the clasp
  for (const m of [...group.children, ...lid.children]) m.castShadow = true;
  group.add(lid);
  const shaft = lightShaft(
    new THREE.CylinderGeometry(0.75, 0.55, 3.2, 24, 1, true),
    "varying vec2 vUv; varying vec3 vN, vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.); vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }",
    `uniform float uA, uTime; varying vec2 vUv; varying vec3 vN, vV;
      void main(){ float d = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), y = clamp(1.0 - vUv.y, 0.0, 1.0);
        float rays = 0.6 + 0.4 * step(0.5, fract(vUv.x * 9.0 + uTime * 0.05));
        float a = uA * d * sqrt(d) * y * y * rays * 0.15;   // no pow(): pow(0, y) is NaN on some GPUs
        gl_FragColor = vec4(vec3(1.0, 0.7, 0.3) * a, 1.0); }`,
  );
  shaft.position.y = 0.62 + 1.6;
  group.add(shaft);
  const light = new THREE.PointLight(0xffb44a, 0, 6, 1.6);
  light.position.set(0, 1.0, 0.1);
  group.add(light);
  return { group, lid, shaft, light, gold: goldMat };
}

export function buildHoard({ radius = 1.6, cell = 0.14 }: { radius?: number; cell?: number } = {}) {
  const cols: HoardColumn[] = [];
  const n = Math.ceil(radius / cell);
  for (let a = -n; a <= n; a++)
    for (let b = -n; b <= n; b++) {
      const r = Math.hypot(a, b) * cell;
      if (r > radius * (0.85 + hash(a, b) * 0.2)) continue;
      const h = Math.max(
        cell * 0.5,
        Math.round((Math.pow(Math.max(0, 1 - r / radius), 1.15) * 1.25 + hash(a * 3, b) * 0.1) / (cell * 0.5)) *
          cell *
          0.5,
      );
      cols.push({
        x: a * cell,
        z: b * cell,
        h,
        gem: hash(a + 5, b * 2) > 0.965 ? (hash(a, b + 9) > 0.5 ? [0.85, 0.15, 0.2] : [0.2, 0.45, 0.95]) : null,
        s: hash(a * 7, b * 5),
      });
    }
  const mat = bevel(
    new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.6, emissive: 0x3a2404, emissiveIntensity: 0.25 }),
    [cell * 0.47, 0.5, cell * 0.47],
    0.7,
  );
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(cell * 0.94, 1, cell * 0.94), mat, cols.length);
  cols.forEach((c, i) => {
    const [r, g, b] = c.gem ?? [0.95, 0.68 + c.s * 0.12, 0.25 + c.s * 0.1];
    mesh.setColorAt(i, col.setRGB(r, g, b, THREE.SRGBColorSpace));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  // the centre column (r = 0) always passes the radius test
  return { mesh, cols, top: cols.find((c) => !c.x && !c.z)!.h };
}

// The finale's stream frame: a 16:9 bezel whose cubes fly in from a scatter (see main.ts), with a lit inner edge.
export function buildFrame({ w = 19.2, h = 10.8, unit = 0.4 }: { w?: number; h?: number; unit?: number } = {}) {
  const slots: [number, number][] = [];
  const nx = Math.round(w / unit),
    ny = Math.round(h / unit);
  for (let i = -1; i <= nx; i++) for (const j of [-1, ny]) slots.push([i, j]);
  for (let j = 0; j < ny; j++) for (const i of [-1, nx]) slots.push([i, j]);
  const list = slots.map(([i, j], k) => ({
    x: (i + 0.5) * unit - w / 2,
    y: (j + 0.5) * unit - h / 2,
    from: new THREE.Vector3((hash(k, 1) - 0.5) * 30, (hash(k, 2) - 0.5) * 18, 6 + hash(k, 3) * 10),
    delay: hash(k, 4) * 0.45,
    spin: (hash(k, 5) - 0.5) * 8,
  }));
  const mat = bevel(
    new THREE.MeshStandardMaterial({ color: 0x6b5434, emissive: 0x3a2410, roughness: 0.35, metalness: 0.75 }),
    [unit * 0.48, unit * 0.48, unit * 0.9],
    0.8,
  );
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(unit * 0.96, unit * 0.96, unit * 1.8), mat, list.length);
  mesh.frustumCulled = false;
  const edgeMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.6, 1.25, 0.75),
    transparent: true,
    opacity: 0,
  });
  const edges = new THREE.Group();
  for (const [ew, eh, ex, ey] of [
    [w, 0.05, 0, h / 2],
    [w, 0.05, 0, -h / 2],
    [0.05, h, -w / 2, 0],
    [0.05, h, w / 2, 0],
  ] satisfies [number, number, number, number][])
    box(edges, edgeMat, [ew, eh, 0.05], [ex, ey, 0.92]);
  const group = new THREE.Group();
  group.add(mesh, edges);
  return { group, mesh, list, edgeMat, w, h, unit };
}
