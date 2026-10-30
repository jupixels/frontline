import * as THREE from 'three';
import { fbm, smoothstep, TerrainModel, valueNoise, WATER_LEVEL } from '../shared/terrain';
import { generateTerrainTextures, loadTerrainTextures, type TerrainTextureSet } from './terrainTextures';

export { WATER_LEVEL };

/**
 * Deterministic terrain height in meters at world (x, z): the shared TerrainModel the sim plays on.
 * Kept as a function for callers that only have a map.
 */
export function terrainHeight(x: number, z: number, model: TerrainModel): number {
  return model.height(x, z);
}

/** How the ground reads under this map's weather. */
export interface GroundMood {
  /** 0..1: how much grass is sun-bleached straw. */
  dry: number;
  /** 0..1: rain-darkened, glossier ground. */
  wet: number;
}

export interface TerrainOptions {
  model: TerrainModel;
  mood?: GroundMood;
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
  readonly model: TerrainModel;
  /** Height samples on a (n+1)² grid. */
  private readonly heights: Float32Array;
  private readonly n: number;
  private readonly step: number;
  private readonly min: number;
  readonly maxHeight: number;
  /** Half-float height texture covering `extent`, used by water for depth/foam. */
  readonly heightTexture: THREE.DataTexture;
  readonly splatTexture: THREE.DataTexture;
  /** RGBA = gravel, dry grass, wetness, cliff. */
  readonly splat2Texture: THREE.DataTexture;
  /** Grass cover 0..255 per height sample (what's left after rock, sand, roads...). Drives grass tufts. */
  private grassCover!: Uint8Array;
  readonly uniforms: {
    tAlbedo: { value: THREE.DataArrayTexture };
    tDetail: { value: THREE.DataArrayTexture };
    tSplat: { value: THREE.Texture };
    tSplat2: { value: THREE.Texture };
    tNoise: { value: THREE.Texture };
    uDry: { value: number };
    uWet: { value: number };
    tDecal: { value: THREE.Texture | null };
    uTerrainBounds: { value: THREE.Vector4 };
    uDecalBounds: { value: THREE.Vector4 };
    uTile: { value: number };
  };

  constructor(opts: TerrainOptions) {
    this.model = opts.model;
    this.mapSize = opts.model.map.size;
    this.extent = opts.extent ?? this.mapSize * 2.4;
    this.n = opts.segments ?? 512;
    this.step = this.extent / this.n;
    this.min = -this.extent / 2;
    const n = this.n;
    const count = (n + 1) * (n + 1);
    this.heights = new Float32Array(count);
    let maxH = -Infinity;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const h = this.model.height(this.min + i * this.step, this.min + j * this.step);
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
    [this.splatTexture, this.splat2Texture] = this.buildSplatTextures(geo);

    const tex = generateTerrainTextures();
    this.uniforms = {
      tAlbedo: { value: tex.albedo },
      tDetail: { value: tex.detail },
      tSplat: { value: this.splatTexture },
      tSplat2: { value: this.splat2Texture },
      tNoise: { value: noiseTexture() },
      uDry: { value: opts.mood?.dry ?? 0.35 },
      uWet: { value: opts.mood?.wet ?? 0 },
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

  /** Top-down map picture for the minimap: hill-shaded ground, water, woods, roads and rock. */
  minimapImage(px = 256): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d')!;
    const img = g.createImageData(px, px);
    const m = this.model;
    const size = this.mapSize;
    const land: Record<string, [number, number, number]> = { temperate: [74, 92, 52], coastal: [82, 96, 62], desert: [168, 140, 96] };
    const base = land[m.style] ?? land.temperate;
    const step = size / px;
    for (let j = 0; j < px; j++) {
      for (let i = 0; i < px; i++) {
        const x = (i + 0.5) * step - size / 2;
        const z = (j + 0.5) * step - size / 2;
        const h = this.heightAt(x, z);
        const hx = this.groundAt(x + step, z) - this.groundAt(x - step, z);
        const hz = this.groundAt(x, z + step) - this.groundAt(x, z - step);
        // Light from the north-west.
        const shade = Math.max(0.55, Math.min(1.35, 1 + (-hx - hz) / (step * 2) * 0.9 + (h - 6) * 0.006));
        let r: number;
        let gg: number;
        let b: number;
        if (h < WATER_LEVEL - 0.1) {
          const deep = Math.min(1, -h / 7);
          r = 46 - deep * 26;
          gg = 86 - deep * 40;
          b = 98 - deep * 30;
        } else if (m.hasCliffs && m.isCliff(x, z)) {
          [r, gg, b] = [96 * shade, 92 * shade, 86 * shade];
        } else if (m.bridges.length && m.bridgeDeck(x, z) !== null) {
          [r, gg, b] = [150, 146, 136];
        } else if (m.roads.length && m.isRoad(x, z)) {
          [r, gg, b] = [150 * shade, 128 * shade, 96 * shade];
        } else if (m.forests.length && m.isForest(x, z)) {
          [r, gg, b] = [36 * shade, 58 * shade, 32 * shade];
        } else {
          [r, gg, b] = [base[0] * shade, base[1] * shade, base[2] * shade];
        }
        const o = (j * px + i) * 4;
        img.data[o] = r;
        img.data[o + 1] = gg;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  setDecals(tex: THREE.Texture, bounds: THREE.Vector4): void {
    this.uniforms.tDecal.value = tex;
    this.uniforms.uDecalBounds.value.copy(bounds);
  }

  /** Where things stand at (x, z): bridge deck on bridges, else the ground. */
  heightAt(x: number, z: number): number {
    if (this.model.bridges.length) {
      const deck = this.model.bridgeDeck(x, z);
      if (deck !== null) return deck;
    }
    return this.groundAt(x, z);
  }

  /** Bilinear ground height in meters at (x, z). Outside the terrain it clamps to the border. */
  groundAt(x: number, z: number): number {
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

  /** Grass cover 0..1 at (x, z): 0 on rock, sand, roads, water and forest floor. */
  grassAt(x: number, z: number): number {
    const n = this.n;
    const i = Math.round((x - this.min) / this.step);
    const j = Math.round((z - this.min) / this.step);
    if (i < 0 || j < 0 || i > n || j > n) return 0;
    return this.grassCover[j * (n + 1) + i] / 255;
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
      if (y <= this.groundAt(x, z)) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          const px = o.x + d.x * mid;
          const pz = o.z + d.z * mid;
          if (o.y + d.y * mid <= this.groundAt(px, pz)) hi = mid;
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

  /**
   * Two splat maps from slope, height, curvature, water, forests, roads and noise:
   * A: RGBA = dirt, rock, sand, mud (grass = remainder); B: RGBA = gravel, dry grass, wetness, cliff.
   * Grass cover per sample is kept on the CPU for the grass tufts.
   */
  private buildSplatTextures(geo: THREE.BufferGeometry): [THREE.DataTexture, THREE.DataTexture] {
    const w = this.n + 1;
    const data = new Uint8Array(w * w * 4);
    const data2 = new Uint8Array(w * w * 4);
    this.grassCover = new Uint8Array(w * w);
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const m = this.model;
    const seed = m.def.seed;
    const desert = m.style === 'desert';
    const coastal = m.style === 'coastal';
    const half = this.mapSize / 2;
    const H = this.heights;
    const at = (i: number, j: number) => H[Math.min(Math.max(j, 0), w - 1) * w + Math.min(Math.max(i, 0), w - 1)];
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const h = pos.getY(v);
      const i = Math.round((x - this.min) / this.step);
      const j = Math.round((z - this.min) / this.step);
      const ny = nrm.getY(v);
      // Convexity over ~4 samples: ridges/hilltops positive, gullies negative.
      const ring = (at(i - 3, j) + at(i + 3, j) + at(i, j - 3) + at(i, j + 3)) / 4;
      const convex = THREE.MathUtils.clamp((h - ring) / 1.5, -1, 1);
      const inside = Math.abs(x) < half + 40 && Math.abs(z) < half + 40;
      const cliff = inside && m.hasCliffs && m.isCliff(x, z) ? 1 : 0;
      const n1 = fbm(x / 75, z / 75, seed + 21, 3);
      const n2 = fbm(x / 31, z / 31, seed + 27, 3);
      const n3 = fbm(x / 140, z / 140, seed + 29, 2);

      // Rock on steep slopes, cliffs, high ground and a few outcrops on crests.
      const steep = smoothstep(0.9, 0.72, ny);
      const outcrop = smoothstep(0.66, 0.78, n2) * smoothstep(0.1, 0.5, convex) * (desert ? 0.7 : 0.55);
      const rock = Math.min(1, Math.max(steep, smoothstep(22, 45, h) * 0.85, cliff * 0.95, outcrop));
      // Shore: sand band above the waterline, wet ground at it.
      const shoreH = coastal ? 3.4 : 2.2;
      let sand = smoothstep(shoreH, 0.9, h) * (1 - rock);
      const wet = smoothstep(1.3, 0.25, h) * (1 - rock * 0.5);
      let dirt = smoothstep(0.5, 0.75, n1) * 0.75 * (1 - rock) * (1 - sand);
      // Mud in wet hollows and along river banks (not on beaches).
      const hollow = smoothstep(-0.05, -0.45, convex);
      let mud = Math.max(
        smoothstep(0.6, 0.72, fbm(x / 45, z / 45, seed + 33, 3)) * smoothstep(5.5, 2.5, h) * 0.9,
        hollow * smoothstep(0.45, 0.65, n2) * 0.7,
        coastal ? 0 : wet * 0.8,
      ) * (1 - rock) * (1 - sand * 0.7);
      // Gravel: scree at the foot of steep ground, scattered patches.
      let gravel = Math.max(smoothstep(0.96, 0.86, ny) * (1 - steep) * 0.75, smoothstep(0.72, 0.8, n1) * smoothstep(0.4, 0.6, n3) * 0.6) * (1 - sand);
      // Sun-bleached grass on crests and in broad patches.
      let dry = Math.min(1, smoothstep(0.45, 0.7, n3) * 0.8 + Math.max(0, convex) * 0.5 + smoothstep(0.6, 0.8, n2) * 0.25);
      if (desert) {
        // Desert: sand everywhere, packed dirt and gravel pans, rock on slopes.
        sand = Math.max(sand, (1 - rock) * (0.75 + 0.25 * n1));
        dirt = smoothstep(0.55, 0.8, n1) * 0.55 * (1 - rock);
        gravel = Math.max(gravel, smoothstep(0.6, 0.75, n3) * 0.6 * (1 - rock));
        mud = 0;
        dry = 1;
      }
      const forest = inside && m.forests.length > 0 && m.isForest(x, z);
      if (forest) {
        // Forest floor: dark dirt and leaf litter.
        dirt = Math.max(dirt, 0.55);
        mud = Math.max(mud, desert ? 0 : 0.3);
        sand *= 0.3;
        gravel *= 0.3;
      }
      const road = inside && m.roads.length > 0 && m.isRoad(x, z);
      if (road) {
        dirt = 0.85;
        gravel = Math.max(gravel, 0.5);
        mud = 0;
        sand = desert ? 0.3 : 0;
      }
      let r = dirt;
      let g = rock;
      let b = sand;
      let a = mud;
      let gr = gravel;
      const sum = r + g + b + a + gr;
      if (sum > 1) {
        r /= sum;
        g /= sum;
        b /= sum;
        a /= sum;
        gr /= sum;
      }
      const o = (j * w + i) * 4;
      data[o] = r * 255;
      data[o + 1] = g * 255;
      data[o + 2] = b * 255;
      data[o + 3] = a * 255;
      data2[o] = gr * 255;
      data2[o + 1] = dry * 255;
      data2[o + 2] = wet * 255;
      data2[o + 3] = Math.max(cliff, steep) * 255;
      const grass = Math.max(0, 1 - r - g - b - a - gr) * (h > 0.6 ? 1 : 0) * (forest || road ? 0 : 1);
      this.grassCover[j * w + i] = grass * 255;
    }
    const make = (d: Uint8Array) => {
      const tex = new THREE.DataTexture(d, w, w, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    };
    return [make(data), make(data2)];
  }
}

/** Tileable 256² value noise: R/G/B at three frequencies, A per-cell random. Breaks up texture tiling. */
let sharedNoise: THREE.DataTexture | null = null;
export function noiseTexture(): THREE.DataTexture {
  if (sharedNoise && sharedNoise.image) return sharedNoise;
  const size = 256;
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const o = (y * size + x) * 4;
      d[o] = fbm(u * 4, v * 4, 901, 3, 4) * 255;
      d[o + 1] = fbm(u * 12, v * 12, 902, 3, 12) * 255;
      d[o + 2] = fbm(u * 40, v * 40, 903, 2, 40) * 255;
      d[o + 3] = valueNoise(Math.floor(u * 32) + 0.5, Math.floor(v * 32) + 0.5, 904, 32) * 255;
    }
  }
  sharedNoise = new THREE.DataTexture(d, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  sharedNoise.wrapS = sharedNoise.wrapT = THREE.RepeatWrapping;
  sharedNoise.minFilter = THREE.LinearMipmapLinearFilter;
  sharedNoise.magFilter = THREE.LinearFilter;
  sharedNoise.generateMipmaps = true;
  sharedNoise.needsUpdate = true;
  return sharedNoise;
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
uniform sampler2D tSplat2;
uniform sampler2D tNoise;
uniform sampler2D tDecal;
uniform vec4 uTerrainBounds;
uniform vec4 uDecalBounds;
uniform float uTile;
uniform float uDry;
uniform float uWet;
varying vec3 vTWorld;
varying vec3 vTNormal;
`;

// Height-blended splatting over 6 layers (grass, dirt, rock, sand, mud, gravel). Anti-tiling: each layer
// is sampled at two scales whose mix is driven by world noise; rock on steep ground is projected
// triplanar so cliffs don't smear. A second splat adds bleached grass, wet shores and cliff tint.
const TERRAIN_FRAG_ALBEDO = /* glsl */ `
vec2 tUv = vTWorld.xz / uTile;
vec2 tUv2 = mat2(0.8, -0.6, 0.6, 0.8) * vTWorld.xz / (uTile * 4.7);
// Explicit gradients: the layer loop below branches per pixel, where implicit derivatives are undefined.
vec2 gx1 = dFdx(tUv), gy1 = dFdy(tUv), gx2 = dFdx(tUv2), gy2 = dFdy(tUv2);
vec2 sUv = (vTWorld.xz - uTerrainBounds.xy) / uTerrainBounds.zw;
vec4 sw = texture2D(tSplat, sUv);
vec4 sw2 = texture2D(tSplat2, sUv);
vec4 nz = texture2D(tNoise, vTWorld.xz / 260.0);
vec4 nz2 = texture2D(tNoise, vTWorld.zx / 57.0 + 0.37);
// Noise jitter of the splat weights so borders meander instead of following the height grid.
float jit = (nz2.g - 0.5) * 0.35;
float w[6];
w[1] = clamp(sw.r + jit * sw.r, 0.0, 1.0);
w[2] = sw.g;
w[3] = clamp(sw.b - jit * 0.5 * sw.b, 0.0, 1.0);
w[4] = clamp(sw.a + jit * sw.a, 0.0, 1.0);
w[5] = clamp(sw2.r + jit * sw2.r, 0.0, 1.0);
w[0] = max(0.0, 1.0 - w[1] - w[2] - w[3] - w[4] - w[5]);
float scaleMix = smoothstep(0.3, 0.7, nz.g);
vec4 dt[6];
float hmax = -1.0;
float hb[6];
for (int i = 0; i < 6; i++) {
  dt[i] = textureGrad(tDetail, vec3(tUv, float(i)), gx1, gy1);
  hb[i] = w[i] + dt[i].b * 0.6;
  hmax = max(hmax, w[i] > 0.001 ? hb[i] : -1.0);
}
vec3 n0w = normalize(vTNormal);
float slopeK = smoothstep(0.85, 0.6, n0w.y);
// Triplanar UVs and their gradients, taken outside the branching loop.
vec2 uvx = vTWorld.zy / uTile;
vec2 uvz = vTWorld.xy / uTile;
vec2 gxx = dFdx(uvx), gyx = dFdy(uvx), gxz = dFdx(uvz), gyz = dFdy(uvz);
float wsum = 0.0;
vec3 tAlb = vec3(0.0);
float tRough = 0.0;
vec2 tN = vec2(0.0);
float tCav = 0.0;
for (int i = 0; i < 6; i++) {
  float k = w[i] > 0.001 ? max(hb[i] - hmax + 0.35, 0.0) : 0.0;
  if (k <= 0.0) continue;
  vec4 a = textureGrad(tAlbedo, vec3(tUv, float(i)), gx1, gy1);
  vec4 a2 = textureGrad(tAlbedo, vec3(tUv2, float(i)), gx2, gy2);
  a = mix(a, a2, 0.3 + 0.4 * scaleMix);
  if (i == 2 && slopeK > 0.01) {
    // Triplanar rock: project from the side on cliffs.
    vec3 bw = abs(n0w);
    bw = bw / (bw.x + bw.y + bw.z);
    vec4 ax = textureGrad(tAlbedo, vec3(uvx, 2.0), gxx, gyx);
    vec4 az = textureGrad(tAlbedo, vec3(uvz, 2.0), gxz, gyz);
    vec4 tri = ax * bw.x + a * bw.y + az * bw.z;
    a = mix(a, tri, slopeK);
  }
  if (i == 0) {
    // Grass: lush/bleached variation. Straw where the splat says dry, scaled by the map's mood.
    float dry = clamp(sw2.g * (0.4 + uDry) + (nz.r - 0.5) * 0.5 * uDry, 0.0, 1.0);
    vec3 straw = vec3(dot(a.rgb, vec3(0.3, 0.59, 0.11))) * vec3(1.32, 1.12, 0.68);
    a.rgb = mix(a.rgb, straw, dry * 0.85);
    a.rgb *= 0.86 + 0.28 * nz2.b;
  }
  tAlb += a.rgb * k;
  tRough += a.a * k;
  tN += (dt[i].rg * 2.0 - 1.0) * k;
  tCav += dt[i].a * k;
  wsum += k;
}
tAlb /= wsum; tRough /= wsum; tN /= wsum; tCav /= wsum;
// Broad macro variation in brightness and hue (kills visible tiling at RTS zoom).
tAlb *= 0.78 + nz.r * 0.44;
tAlb *= mix(vec3(1.0), vec3(1.06, 1.0, 0.9), smoothstep(0.4, 0.8, nz.b));
tAlb *= mix(1.0, tCav, 0.6);
// Wet shores and rain: darker, glossier. Puddle-ish glossy spots in rain.
float wetK = clamp(sw2.b + uWet * (0.45 + 0.4 * smoothstep(0.55, 0.75, nz2.r)), 0.0, 1.0);
tAlb *= 1.0 - wetK * 0.42;
tRough = mix(tRough, 0.32, wetK * 0.75);
tN *= 1.0 - wetK * 0.4;

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
