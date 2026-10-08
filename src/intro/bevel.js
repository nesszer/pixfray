// Bevelled voxels without extra geometry: near a cube's edges the shading normal leans toward the neighbouring face,
// so every edge catches the light like a rounded block. Works on instanced and scaled boxes; half = the box's half-extents.
import * as THREE from "three";

export function bevel(mat, half, amount = 0.85, width = 0.24) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.uniforms.uHalf = { value: new THREE.Vector3(...half) };
    sh.uniforms.uBevel = { value: new THREE.Vector2(amount, width) };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLp, vNo, vSc, vAx, vAy, vAz;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        mat3 bvM = mat3(1.0);
        #ifdef USE_INSTANCING
          bvM = mat3(instanceMatrix);
        #endif
        vLp = position; vNo = normal;
        vSc = vec3(length(bvM[0]), length(bvM[1]), length(bvM[2]));
        vAx = normalMatrix * bvM[0]; vAy = normalMatrix * bvM[1]; vAz = normalMatrix * bvM[2];`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uHalf; uniform vec2 uBevel; varying vec3 vLp, vNo, vSc, vAx, vAy, vAz;",
      )
      .replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
        {
          vec3 hw = uHalf * vSc, off = 1.0 - abs(vNo);            // off: 0 on the face's own axis
          vec3 hm = mix(vec3(1e3), hw, off);
          float w = uBevel.y * min(hm.x, min(hm.y, hm.z));         // bevel width follows the face's short side
          vec3 e = 1.0 - clamp((uHalf - abs(vLp)) * vSc / w, 0.0, 1.0); e = off * e * e;
          vec3 s = sign(vLp);
          normal = normalize(normal + uBevel.x * (e.x * s.x * normalize(vAx) + e.y * s.y * normalize(vAy) + e.z * s.z * normalize(vAz)));
        }`,
      );
  };
  mat.customProgramCacheKey = () => "bevel|" + prev.toString();
  return mat;
}
