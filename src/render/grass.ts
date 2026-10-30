import * as THREE from 'three';
import { hash2 } from '../shared/terrain';
import type { Atmosphere } from './environment';
import type { QualitySettings } from './quality';
import type { Terrain } from './terrain';

/** Meters per placement cell. */
const CELL = 6;
/** Rebuild instances once the view center moves this far. */
const REBUILD_DIST = 8;

/**
 * Grass and weed tufts near the camera: one InstancedMesh of crossed alpha-tested cards, placed on a
 * grid around the view center wherever the terrain is grassy (deterministic per cell, so tufts don't
 * pop when rebuilt), swaying in the map's wind and dithering out with distance. Off on Low.
 */
export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly uniforms = {
    uCenter: { value: new THREE.Vector3() },
    uRadius: { value: 80 },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3(0.6, 0.8, 0.3) },
  };
  private capacity = 0;
  private radius = 0;
  private readonly last = new THREE.Vector3(1e9, 0, 1e9);
  private readonly palette: THREE.Color[];
  private readonly density: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly terrain: Terrain,
    atmosphere: Atmosphere,
  ) {
    const desert = terrain.model.style === 'desert';
    // Desert gets sparse dry scrub; elsewhere grass from lush to straw depending on the mood.
    this.density = desert ? 0.2 : 1;
    const dry = desert ? 1 : atmosphere.ground.dry;
    const green = [new THREE.Color(0x9aae5a), new THREE.Color(0xa9b866), new THREE.Color(0x8ea252)];
    const straw = [new THREE.Color(0xd4c286), new THREE.Color(0xc6b47c), new THREE.Color(0xdccb95)];
    this.palette = green.map((g, i) => g.clone().lerp(straw[i], Math.min(1, dry * 0.8)));
    if (atmosphere.ground.wet > 0.4) for (const p of this.palette) p.multiplyScalar(0.8);
    (this.uniforms.uWind.value as THREE.Vector3).set(Math.sin(atmosphere.wind.heading), Math.cos(atmosphere.wind.heading), 0.15 + atmosphere.wind.strength * 0.45);

    this.material = new THREE.MeshStandardMaterial({ map: bladeTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GRASS_VERT_HEAD}`)
        .replace('#include <begin_vertex>', GRASS_VERT_SWAY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        // Up-facing normal on both card sides (double-sided would flip it and darken back faces).
        .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;')
        .replace('#include <alphatest_fragment>', GRASS_FRAG_FADE);
    };
    this.material.customProgramCacheKey = () => 'frontline-grass';
    this.mesh = new THREE.InstancedMesh(tuftGeometry(), this.material, 1);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'grass';
  }

  setQuality(q: QualitySettings): void {
    this.radius = q.grassRadius;
    this.uniforms.uRadius.value = q.grassRadius;
    if (q.grassCount !== this.capacity) {
      this.capacity = q.grassCount;
      this.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.capacity) * 16), 16);
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.capacity) * 3), 3);
      this.mesh.count = 0;
      this.last.set(1e9, 0, 1e9);
    }
    this.mesh.visible = this.capacity > 0;
  }

  /** Re-place tufts around the view center when it has moved; hide when zoomed far out. */
  update(center: THREE.Vector3, viewDistance: number, time: number): void {
    this.uniforms.uTime.value = time;
    // Tufts are a close-up detail: invisible (sub-pixel) when the camera is pulled back.
    const show = this.capacity > 0 && viewDistance < 230;
    this.mesh.visible = show;
    if (!show) return;
    this.uniforms.uCenter.value.copy(center);
    if (Math.hypot(center.x - this.last.x, center.z - this.last.z) < REBUILD_DIST) return;
    this.last.copy(center);
    this.rebuild(center);
  }

  private rebuild(center: THREE.Vector3): void {
    const r = this.radius;
    const r2 = r * r;
    const c0x = Math.floor((center.x - r) / CELL);
    const c1x = Math.floor((center.x + r) / CELL);
    const c0z = Math.floor((center.z - r) / CELL);
    const c1z = Math.floor((center.z + r) / CELL);
    const perCell = 3.5 * this.density;
    let n = 0;
    const cap = this.capacity;
    for (let cz = c0z; cz <= c1z && n < cap; cz++) {
      for (let cx = c0x; cx <= c1x && n < cap; cx++) {
        const mx = (cx + 0.5) * CELL - center.x;
        const mz = (cz + 0.5) * CELL - center.z;
        if (mx * mx + mz * mz > r2) continue;
        // Clumps: a low-frequency hash decides how many tufts this cell gets.
        const clump = hash2(Math.floor(cx / 3), Math.floor(cz / 3), 77);
        const count = Math.round(perCell * (0.3 + clump * 1.4));
        for (let k = 0; k < count && n < cap; k++) {
          const hx = hash2(cx * 7 + k, cz * 13 - k, 101);
          const hz = hash2(cx * 11 - k, cz * 5 + k, 202);
          const x = (cx + hx) * CELL;
          const z = (cz + hz) * CELL;
          const cover = this.terrain.grassAt(x, z);
          if (cover < 0.35 || hash2(cx + k * 31, cz - k * 17, 303) > cover) continue;
          const y = this.terrain.groundAt(x, z);
          const size = 0.6 + hash2(cx - k, cz + k * 3, 404) * 0.7;
          this.q.setFromAxisAngle(this.up, hash2(cx + k, cz + k, 505) * Math.PI * 2);
          // Low and wide: tall cards catch ambient occlusion and read as dark dots from above.
          this.s.set(size * 1.3, size * (0.62 + clump * 0.35), size * 1.3);
          this.m.compose(this.p.set(x, y - 0.05, z), this.q, this.s);
          this.mesh.setMatrixAt(n, this.m);
          const pal = this.palette[Math.floor(hash2(cx * 3 + k, cz, 606) * this.palette.length) % this.palette.length];
          this.c.copy(pal).multiplyScalar(0.85 + hash2(cx, cz * 3 + k, 707) * 0.3);
          this.mesh.setColorAt(n, this.c);
          n++;
        }
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

const GRASS_VERT_HEAD = /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
uniform float uTime;
uniform vec3 uWind;
varying float vFade;
`;

// Sway grows with height (uv.y); phase varies per instance. Normals point up so tufts shade like the ground.
const GRASS_VERT_SWAY = /* glsl */ `
vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 iPos = vec3(0.0);
#endif
float phase = dot(iPos.xz, vec2(0.13, 0.11)) + uTime * (1.4 + uWind.z * 2.0);
float gust = 0.6 + 0.4 * sin(dot(iPos.xz, uWind.xy) * 0.03 - uTime * 0.9);
float bend = uv.y * uv.y * (sin(phase) * 0.35 + 0.65) * uWind.z * gust;
// Wind is a world direction; bring it into the tuft's rotated, scaled frame.
#ifdef USE_INSTANCING
vec3 lw = transpose(mat3(instanceMatrix)) * vec3(uWind.x, 0.0, uWind.y);
lw /= max(dot(lw, lw), 1e-4);
#else
vec3 lw = vec3(uWind.x, 0.0, uWind.y);
#endif
transformed.xz += lw.xz * bend * 0.6;
float d = length(iPos.xz - uCenter.xz);
vFade = 1.0 - smoothstep(uRadius * 0.55, uRadius, d);
// Shrink into the ground as they fade, so the edge never shows a hard ring.
transformed *= 0.35 + 0.65 * vFade;
`;

const GRASS_FRAG_FADE = /* glsl */ `
// Ordered dither: fade by discarding a growing share of pixels (no sorting needed).
float dither = fract(dot(gl_FragCoord.xy, vec2(0.0671, 0.00583)) * 52.98);
// Dithered alpha edge: blades feather out instead of ending in a hard cut-out outline.
if (diffuseColor.a < 0.15 + dither * 0.4 || dither > vFade) discard;
`;

/** Three crossed cards, 1 m tall, pivot at the base; normals point up. */
function tuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const b = positions.length / 3;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

/** Blades and a few seed heads drawn on a canvas: white-ish, tinted per instance. */
function bladeTexture(): THREE.Texture {
  const W = 128;
  const H = 128;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = W * (0.15 + rnd() * 0.7);
    const h = H * (0.45 + rnd() * 0.52);
    const lean = (rnd() - 0.5) * W * 0.35;
    const w = 1.6 + rnd() * 2;
    const grad = g.createLinearGradient(0, H, 0, H - h);
    const tone = 195 + rnd() * 60;
    // Nearly flat shading along the blade: dark bases read as dirt specks from above.
    grad.addColorStop(0, `rgb(${tone * 0.88},${tone * 0.9},${tone * 0.82})`);
    grad.addColorStop(1, `rgb(${tone},${tone},${tone * 0.9})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w, H);
    g.quadraticCurveTo(x + lean * 0.3, H - h * 0.6, x + lean, H - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.3, H - h * 0.6, x + w, H);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
