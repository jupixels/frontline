import * as THREE from 'three';
import { fbm, lerp, ridged, smoothstep } from './noise';
import { generateTerrainTextures, loadTerrainTextures, type TerrainTextureSet } from './terrainTextures';

export const WATER_LEVEL = 0;

/**
 * Deterministic terrain height in meters at world (x, z). Rolling farmland inside the playable square,
 * rim hills outside it, and a coastline along the north (-z) edge so naval units have somewhere to be.
 *
 * Uses only + - * / and floor so it can be promoted to shared/ and used by the sim as-is.
 * TODO(sim): the sim is flat 2D today. When it needs heights (line of sight, naval pathing), promote
 * this function (and noise.ts) to src/shared/terrain.ts and drive it from MapDef.
 */
export function terrainHeight(x: number, z: number, mapSize: number, seed: number): number {
  const half = mapSize / 2;
  let h = 4 + (fbm(x / 230, z / 230, seed, 4) - 0.5) * 9 + (fbm(x / 55, z / 55, seed + 7, 3) - 0.5) * 1.6;
  // Keep the playable land comfortably above the water line.
  if (h < 1.2) h = 1.2 - (1.2 - h) * 0.2;

  // Rim hills rise beyond the playable square.
  const ax = x < 0 ? -x : x;
  const az = z < 0 ? -z : z;
  const out = (ax > az ? ax : az) - half;
  const rim = smoothstep(-30, 180, out);
  const ridge = ridged(x / 160, z / 160, seed + 3, 4);
  h += rim * (10 + ridge * 70 + fbm(x / 70, z / 70, seed + 4, 3) * 12);

  // Coastline along -z, wobbling with noise. Sea floor slopes down to ~-9 m.
  const shore = -half * 0.8 + (fbm(x / 150, 3.5, seed + 11, 3) - 0.5) * 90;
  const sea = smoothstep(shore + 30, shore - 40, z);
  const floor = -2.5 - smoothstep(shore, shore - 160, z) * 6.5 + (fbm(x / 40, z / 40, seed + 12, 2) - 0.5) * 1.5;
  return lerp(h, floor, sea);
}

export interface TerrainOptions {
  mapSize: number;
  seed: number;
  /** Side length of the rendered terrain (covers the map plus scenic surroundings). */
  extent?: number;
  segments?: number;
}

/** Heightmap terrain mesh with splat-blended PBR layers, decal support and height queries. */
export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly extent: number;
  readonly mapSize: number;
  /** Height samples on a (n+1)² grid. */
  private readonly heights: Float32Array;
  private readonly n: number;
  private readonly step: number;
  private readonly min: number;
  readonly maxHeight: number;
  /** Half-float height texture covering `extent`, used by water for depth/foam. */
  readonly heightTexture: THREE.DataTexture;
  readonly splatTexture: THREE.DataTexture;
  readonly uniforms: {
    tAlbedo: { value: THREE.DataArrayTexture };
    tDetail: { value: THREE.DataArrayTexture };
    tSplat: { value: THREE.Texture };
    tDecal: { value: THREE.Texture | null };
    uTerrainBounds: { value: THREE.Vector4 };
    uDecalBounds: { value: THREE.Vector4 };
    uTile: { value: number };
  };

  constructor(opts: TerrainOptions) {
    this.mapSize = opts.mapSize;
    this.extent = opts.extent ?? opts.mapSize * 2.4;
    this.n = opts.segments ?? 448;
    this.step = this.extent / this.n;
    this.min = -this.extent / 2;
    const n = this.n;
    const count = (n + 1) * (n + 1);
    this.heights = new Float32Array(count);
    let maxH = -Infinity;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const h = terrainHeight(this.min + i * this.step, this.min + j * this.step, opts.mapSize, opts.seed);
        this.heights[j * (n + 1) + i] = h;
        if (h > maxH) maxH = h;
      }
    }
    this.maxHeight = maxH;

    const geo = new THREE.PlaneGeometry(this.extent, this.extent, n, n).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const i = Math.round((pos.getX(v) - this.min) / this.step);
      const j = Math.round((pos.getZ(v) - this.min) / this.step);
      pos.setY(v, this.heights[j * (n + 1) + i]);
    }
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    this.heightTexture = this.buildHeightTexture();
    this.splatTexture = this.buildSplatTexture(geo, opts.seed);

    const tex = generateTerrainTextures();
    this.uniforms = {
      tAlbedo: { value: tex.albedo },
      tDetail: { value: tex.detail },
      tSplat: { value: this.splatTexture },
      tDecal: { value: null },
      uTerrainBounds: { value: new THREE.Vector4(this.min, this.min, this.extent, this.extent) },
      uDecalBounds: { value: new THREE.Vector4(-1, -1, 2, 2) },
      uTile: { value: 9 },
    };
    this.material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    this.material.onBeforeCompile = (shader) => patchTerrainShader(shader, this.uniforms);
    this.material.customProgramCacheKey = () => 'frontline-terrain';
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
  }

  /** Swap in the CC0 texture pack when present. Safe to call once at startup. */
  async loadTextures(size = 1024): Promise<void> {
    const fallback: TerrainTextureSet = { albedo: this.uniforms.tAlbedo.value, detail: this.uniforms.tDetail.value };
    const loaded = await loadTerrainTextures(fallback, size);
    if (!loaded) return;
    this.uniforms.tAlbedo.value = loaded.albedo;
    this.uniforms.tDetail.value = loaded.detail;
    this.uniforms.uTile.value = 9;
  }

  setDecals(tex: THREE.Texture, bounds: THREE.Vector4): void {
    this.uniforms.tDecal.value = tex;
    this.uniforms.uDecalBounds.value.copy(bounds);
  }

  /** Bilinear height in meters at (x, z). Outside the terrain it clamps to the border. */
  heightAt(x: number, z: number): number {
    const n = this.n;
    const fx = Math.min(Math.max((x - this.min) / this.step, 0), n - 1e-4);
    const fz = Math.min(Math.max((z - this.min) / this.step, 0), n - 1e-4);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const w = n + 1;
    const h = this.heights;
    const a = h[j * w + i];
    const b = h[j * w + i + 1];
    const c = h[(j + 1) * w + i];
    const d = h[(j + 1) * w + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** Surface normal at (x, z) via central differences. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = this.step;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < WATER_LEVEL - 0.15;
  }

  /** Ray-march the heightfield. Much cheaper than a triangle raycast against ~400k triangles. */
  raycast(ray: THREE.Ray, out = new THREE.Vector3()): THREE.Vector3 | null {
    const o = ray.origin;
    const d = ray.direction;
    if (d.y >= 0 && o.y > this.maxHeight) return null;
    // Start where the ray dips below the highest point of the terrain.
    let t = o.y > this.maxHeight && d.y < 0 ? (o.y - this.maxHeight) / -d.y : 0;
    const maxT = t + this.extent * 1.5;
    const stepLen = this.step * 0.5;
    let prevT = t;
    while (t < maxT) {
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      if (Math.abs(x) > this.extent / 2 || Math.abs(z) > this.extent / 2) return null;
      const y = o.y + d.y * t;
      if (y <= this.heightAt(x, z)) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          const px = o.x + d.x * mid;
          const pz = o.z + d.z * mid;
          if (o.y + d.y * mid <= this.heightAt(px, pz)) hi = mid;
          else lo = mid;
        }
        return out.copy(o).addScaledVector(d, hi);
      }
      prevT = t;
      t += stepLen;
    }
    return null;
  }

  private buildHeightTexture(): THREE.DataTexture {
    const w = this.n + 1;
    const data = new Uint16Array(w * w);
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(this.heights[i]);
    const tex = new THREE.DataTexture(data, w, w, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  /** RGBA = dirt, rock, sand, mud weights (grass = remainder), from slope, height and noise. */
  private buildSplatTexture(geo: THREE.BufferGeometry, seed: number): THREE.DataTexture {
    const w = this.n + 1;
    const data = new Uint8Array(w * w * 4);
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const h = pos.getY(v);
      const i = Math.round((x - this.min) / this.step);
      const j = Math.round((z - this.min) / this.step);
      const ny = nrm.getY(v);
      const rock = Math.max(smoothstep(0.9, 0.74, ny), smoothstep(22, 45, h) * 0.85);
      const sand = smoothstep(2.4, 1.0, h) * (1 - rock);
      const patches = fbm(x / 75, z / 75, seed + 21, 3);
      const dirt = smoothstep(0.5, 0.75, patches) * 0.8 * (1 - rock) * (1 - sand);
      const wet = fbm(x / 45, z / 45, seed + 33, 3);
      const mud = smoothstep(0.6, 0.72, wet) * smoothstep(5.5, 2.5, h) * 0.9 * (1 - rock) * (1 - sand);
      let r = dirt;
      let g = rock;
      let b = sand;
      let a = mud;
      const sum = r + g + b + a;
      if (sum > 1) {
        r /= sum;
        g /= sum;
        b /= sum;
        a /= sum;
      }
      const o = (j * w + i) * 4;
      data[o] = r * 255;
      data[o + 1] = g * 255;
      data[o + 2] = b * 255;
      data[o + 3] = a * 255;
    }
    const tex = new THREE.DataTexture(data, w, w, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }
}

function patchTerrainShader(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Terrain['uniforms']): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;')
    .replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTNormal = normalize(mat3(modelMatrix) * objectNormal);',
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_HEAD}`)
    .replace('#include <map_fragment>', TERRAIN_FRAG_ALBEDO)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
    .replace('#include <normal_fragment_maps>', TERRAIN_FRAG_NORMAL);
}

const TERRAIN_FRAG_HEAD = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tDetail;
uniform sampler2D tSplat;
uniform sampler2D tDecal;
uniform vec4 uTerrainBounds;
uniform vec4 uDecalBounds;
uniform float uTile;
varying vec3 vTWorld;
varying vec3 vTNormal;
`;

// Height-blended splatting over 5 layers. Each albedo is sampled at two scales (one rotated)
// to break up tiling; a very low-frequency sample adds macro color variation.
const TERRAIN_FRAG_ALBEDO = /* glsl */ `
vec2 tUv = vTWorld.xz / uTile;
vec2 tUv2 = mat2(0.8, -0.6, 0.6, 0.8) * vTWorld.xz / (uTile * 4.7);
// Explicit gradients: the layer loop below branches per pixel, where implicit derivatives are undefined.
vec2 gx1 = dFdx(tUv), gy1 = dFdy(tUv), gx2 = dFdx(tUv2), gy2 = dFdy(tUv2);
vec4 sw = texture2D(tSplat, (vTWorld.xz - uTerrainBounds.xy) / uTerrainBounds.zw);
float w[5];
w[0] = max(0.0, 1.0 - sw.r - sw.g - sw.b - sw.a);
w[1] = sw.r; w[2] = sw.g; w[3] = sw.b; w[4] = sw.a;
vec4 dt[5];
float hmax = -1.0;
float hb[5];
for (int i = 0; i < 5; i++) {
  dt[i] = textureGrad(tDetail, vec3(tUv, float(i)), gx1, gy1);
  hb[i] = w[i] + dt[i].b * 0.6;
  hmax = max(hmax, w[i] > 0.001 ? hb[i] : -1.0);
}
float wsum = 0.0;
vec3 tAlb = vec3(0.0);
float tRough = 0.0;
vec2 tN = vec2(0.0);
float tCav = 0.0;
for (int i = 0; i < 5; i++) {
  float k = w[i] > 0.001 ? max(hb[i] - hmax + 0.35, 0.0) : 0.0;
  if (k <= 0.0) continue;
  vec4 a = textureGrad(tAlbedo, vec3(tUv, float(i)), gx1, gy1);
  vec4 a2 = textureGrad(tAlbedo, vec3(tUv2, float(i)), gx2, gy2);
  a = mix(a, a2, 0.5);
  tAlb += a.rgb * k;
  tRough += a.a * k;
  tN += (dt[i].rg * 2.0 - 1.0) * k;
  tCav += dt[i].a * k;
  wsum += k;
}
tAlb /= wsum; tRough /= wsum; tN /= wsum; tCav /= wsum;
// Two very low-frequency samples of the grass height channel as macro variation (kills visible tiling).
float macro = texture(tDetail, vec3(vTWorld.xz / 173.0, 0.0)).b * 0.6 + texture(tDetail, vec3(vTWorld.zx / 61.0, 3.0)).b * 0.4;
tAlb *= 0.72 + macro * 0.56;
tAlb *= mix(1.0, tCav, 0.6);

vec2 dUv = (vTWorld.xz - uDecalBounds.xy) / uDecalBounds.zw;
vec4 decal = (dUv.x > 0.0 && dUv.x < 1.0 && dUv.y > 0.0 && dUv.y < 1.0) ? texture2D(tDecal, dUv) : vec4(0.0);
// R: scorch, G: tracks.
tAlb *= 1.0 - decal.g * 0.35;
tAlb = mix(tAlb, vec3(0.025, 0.022, 0.02), decal.r * 0.88);
tRough = mix(tRough, 1.0, decal.r);
tN *= 1.0 - decal.r * 0.6;
diffuseColor.rgb *= tAlb;
`;

const TERRAIN_FRAG_NORMAL = /* glsl */ `
{
  vec3 n0 = normalize(vTNormal);
  vec3 tt = normalize(vec3(1.0, 0.0, 0.0) - n0 * n0.x);
  vec3 tb = cross(tt, n0);
  vec3 wn = normalize(tt * tN.x + tb * tN.y + n0 * sqrt(max(1.0 - dot(tN, tN), 0.05)));
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}
`;
