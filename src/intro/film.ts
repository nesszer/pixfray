// The last pass: pixel fray between chapters, colour split on hits, soft edges, chapter grade, vignette and grain.
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export function filmPass() {
  const uniforms = {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uFray: { value: 0 },
    uHit: { value: 0 },
    uDir: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uLift: { value: new THREE.Vector3() },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uBlur: { value: 1 },
  };
  return new ShaderPass({
    uniforms,
    vertexShader:
      "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime, uAspect, uFray, uHit, uDir; uniform vec2 uRes; uniform vec3 uLift, uGain; uniform float uBlur; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        vec2 uv = vUv; float frayed = 0.0, tilePx = 1.0; vec2 tileF = vec2(0.5);
        // pixel fray: while the camera travels between chapters, blocks of the frame snap to coarse pixels and slip
        // in the travel direction; the band of frayed blocks sweeps down (or up) the screen as it goes
        if (uFray > 0.001) {
          float bs = 6.0 * uRes.y / 900.0;
          vec2 blk = floor(vUv * uRes / (bs * 6.0));
          float tick = floor(uTime * 12.0), r = h(blk + tick);
          float band = fract(-uDir * uTime * 0.55), dy = abs(vUv.y - band);
          float sweep = smoothstep(0.2, 0.0, min(dy, 1.0 - dy));
          if (r < uFray * sweep * 1.3) {
            tilePx = bs * (1.0 + floor(h(blk * 1.7 + tick) * 2.0));
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
        // depth of field, cheaply: the frame softens toward its edges, so the subject in the middle stays the sharpest thing
        float soft = uBlur * (1.0 - frayed) * smoothstep(0.42, 0.95, length(d0 * vec2(uAspect, 1.0)));
        if (soft > 0.01) {
          vec2 px = soft * 3.2 * uRes.y / 900.0 / uRes; vec3 acc = c;
          for (int k = 0; k < 8; k++) { float a = float(k) * 0.785398 + 0.4; acc += texture2D(tDiffuse, uv + vec2(cos(a), sin(a)) * px * (1.0 + mod(float(k), 2.0))).rgb; }
          c = mix(c, acc / 9.0, min(1.0, soft * 1.4));
        }
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
  }) as ShaderPass & { uniforms: typeof uniforms }; // ShaderPass clones the uniforms, keeping their shape
}
