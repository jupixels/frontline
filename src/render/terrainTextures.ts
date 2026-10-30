import * as THREE from 'three';
import { assetUrl } from '../shared/view';
import { fbm, ridged, smoothstep, valueNoise } from './noise';

/** Splat layers, in texture-array order. The terrain shader indexes them by position. */
export const TERRAIN_LAYERS = ['grass', 'dirt', 'rock', 'sand', 'mud'] as const;
export type TerrainLayer = (typeof TERRAIN_LAYERS)[number];

/**
 * Two texture arrays shared by every terrain layer:
 * - albedo: RGB = base color (sRGB), A = roughness
 * - detail: RG = tangent-space normal XY, B = height (for height-blended splatting), A = cavity/AO
 */
export interface TerrainTextureSet {
  albedo: THREE.DataArrayTexture;
  detail: THREE.DataArrayTexture;
}

const GEN_SIZE = 256;

type Rgb = [number, number, number];

interface LayerRecipe {
  /** Height in [0,1] at texel (u,v) in [0,1) tile space; must tile. */
  height(u: number, v: number): number;
  color(u: number, v: number, h: number): Rgb;
  rough(u: number, v: number, h: number): number;
  normalStrength: number;
}

const hex = (s: string): Rgb => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Periods are in lattice cells per tile so every layer tiles seamlessly.
const RECIPES: Record<TerrainLayer, LayerRecipe> = {
  grass: {
    height: (u, v) => fbm(u * 8, v * 8, 11, 4, 8) * 0.75 + valueNoise(u * 64, v * 64, 12, 64) * 0.25,
    color: (u, v, h) => {
      const dry = smoothstep(0.4, 0.75, fbm(u * 4, v * 4, 13, 3, 4));
      const base = mix3(hex('#46502a'), hex('#5a6332'), h);
      return mix3(base, hex('#7a7346'), dry * 0.6);
    },
    rough: () => 0.95,
    normalStrength: 0.6,
  },
  dirt: {
    height: (u, v) => {
      const pebble = smoothstep(0.62, 0.8, valueNoise(u * 48, v * 48, 21, 48));
      return fbm(u * 6, v * 6, 22, 5, 6) * 0.7 + pebble * 0.3;
    },
    color: (u, v, h) => mix3(hex('#4d4130'), hex('#76664c'), h * 0.8 + fbm(u * 3, v * 3, 23, 2, 3) * 0.2),
    rough: (_u, _v, h) => 0.9 + h * 0.08,
    normalStrength: 2,
  },
  rock: {
    height: (u, v) => {
      const cracks = ridged(u * 5, v * 5, 31, 4, 5);
      return fbm(u * 4, v * 4, 32, 5, 4) * 0.55 + (1 - cracks) * 0.45;
    },
    color: (u, v, h) => {
      const tint = fbm(u * 2, v * 2, 33, 2, 2);
      return mix3(mix3(hex('#4d4a45'), hex('#8c877d'), h), hex('#6e6250'), tint * 0.35);
    },
    rough: (_u, _v, h) => 0.78 + (1 - h) * 0.2,
    normalStrength: 3.5,
  },
  sand: {
    height: (u, v) => {
      // Wind ripples: a warped stripe pattern.
      const warp = fbm(u * 4, v * 4, 41, 3, 4) * 2;
      const s = (u * 18 + warp) % 1;
      const ripple = s < 0.5 ? s * 2 : (1 - s) * 2;
      return ripple * 0.35 + fbm(u * 10, v * 10, 42, 3, 10) * 0.65;
    },
    color: (u, v, h) => mix3(hex('#a08a63'), hex('#c8b38b'), h * 0.6 + fbm(u * 3, v * 3, 43, 2, 3) * 0.4),
    rough: () => 0.88,
    normalStrength: 1.2,
  },
  mud: {
    height: (u, v) => fbm(u * 5, v * 5, 51, 5, 5),
    color: (u, v, h) => {
      const wet = smoothstep(0.55, 0.35, h);
      return mix3(mix3(hex('#3e3124'), hex('#5a4834'), h), hex('#2a2119'), wet * 0.6 + fbm(u * 2, v * 2, 52, 2, 2) * 0.1);
    },
    rough: (_u, _v, h) => 0.35 + smoothstep(0.3, 0.6, h) * 0.5,
    normalStrength: 1.6,
  },
};

function generateLayer(recipe: LayerRecipe, size: number, albedo: Uint8Array, detail: Uint8Array, offset: number): void {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = recipe.height(x / size, y / size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const hh = h[i];
      const c = recipe.color(u, v, hh);
      const o = offset + i * 4;
      albedo[o] = c[0];
      albedo[o + 1] = c[1];
      albedo[o + 2] = c[2];
      albedo[o + 3] = Math.round(Math.min(Math.max(recipe.rough(u, v, hh), 0), 1) * 255);
      const l = h[y * size + ((x + size - 1) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const d = h[((y + size - 1) % size) * size + x];
      const t = h[((y + 1) % size) * size + x];
      let nx = (l - r) * recipe.normalStrength;
      let ny = (d - t) * recipe.normalStrength;
      const len = Math.hypot(nx, ny, 1 / 8);
      nx /= len;
      ny /= len;
      detail[o] = Math.round((nx * 0.5 + 0.5) * 255);
      detail[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      detail[o + 2] = Math.round(hh * 255);
      // Cavity: darker in local pits.
      const cav = Math.min(Math.max(0.75 + (hh - (l + r + d + t) / 4) * 6, 0), 1);
      detail[o + 3] = Math.round(cav * 255);
    }
  }
}

function makeArray(data: Uint8Array, size: number, srgb: boolean): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, size, size, TERRAIN_LAYERS.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural fallback so the terrain looks right before (or without) the CC0 texture pack. */
export function generateTerrainTextures(): TerrainTextureSet {
  const size = GEN_SIZE;
  const layerBytes = size * size * 4;
  const albedo = new Uint8Array(layerBytes * TERRAIN_LAYERS.length);
  const detail = new Uint8Array(layerBytes * TERRAIN_LAYERS.length);
  TERRAIN_LAYERS.forEach((name, i) => generateLayer(RECIPES[name], size, albedo, detail, i * layerBytes));
  return { albedo: makeArray(albedo, size, true), detail: makeArray(detail, size, false) };
}

/** True if a file exists under public/assets/ (Vite's dev server answers missing files with index.html). */
export async function assetExists(path: string): Promise<boolean> {
  try {
    const res = await fetch(assetUrl(path), { method: 'HEAD' });
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function loadPixels(path: string, size: number): Promise<Uint8ClampedArray | null> {
  if (!(await assetExists(path))) return null;
  try {
    const blob = await (await fetch(assetUrl(path))).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0, size, size);
    bmp.close();
    return g.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
}

/** Nearest-texel upscale of a generated layer so it can sit in a larger array next to loaded textures. */
function upscaleLayer(src: Uint8Array, srcSize: number, layer: number, dst: Uint8Array, dstSize: number): void {
  const so = layer * srcSize * srcSize * 4;
  const doff = layer * dstSize * dstSize * 4;
  const k = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    const sy = Math.floor(y * k);
    for (let x = 0; x < dstSize; x++) {
      const si = so + (sy * srcSize + Math.floor(x * k)) * 4;
      const di = doff + (y * dstSize + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

/**
 * Replace procedural layers with the asset session's CC0 textures where they exist:
 * `textures/terrain/<layer>_<albedo|normal|rough>.webp`. Resolves null if none were found.
 */
export async function loadTerrainTextures(fallback: TerrainTextureSet, size: number): Promise<TerrainTextureSet | null> {
  const results = await Promise.all(
    TERRAIN_LAYERS.map(async (name) => {
      const base = `textures/terrain/${name}_`;
      const [albedo, normal, rough] = await Promise.all([
        loadPixels(`${base}albedo.webp`, size),
        loadPixels(`${base}normal.webp`, size),
        loadPixels(`${base}rough.webp`, size),
      ]);
      return { albedo, normal, rough };
    }),
  );
  if (!results.some((r) => r.albedo)) return null;

  const layerBytes = size * size * 4;
  const albedo = new Uint8Array(layerBytes * TERRAIN_LAYERS.length);
  const detail = new Uint8Array(layerBytes * TERRAIN_LAYERS.length);
  const srcA = fallback.albedo.image.data as Uint8Array;
  const srcD = fallback.detail.image.data as Uint8Array;
  results.forEach((r, layer) => {
    const minRough = TERRAIN_LAYERS[layer] === 'mud' ? 0.35 : 0.62;
    upscaleLayer(srcA, GEN_SIZE, layer, albedo, size);
    upscaleLayer(srcD, GEN_SIZE, layer, detail, size);
    const o = layer * layerBytes;
    for (let i = 0; i < size * size; i++) {
      const p = i * 4;
      if (r.albedo) {
        albedo[o + p] = r.albedo[p];
        albedo[o + p + 1] = r.albedo[p + 1];
        albedo[o + p + 2] = r.albedo[p + 2];
        // Use albedo luminance as the blend height when the pack has no height map.
        detail[o + p + 2] = Math.round(r.albedo[p] * 0.3 + r.albedo[p + 1] * 0.59 + r.albedo[p + 2] * 0.11);
        detail[o + p + 3] = 255;
      }
      // Bare ground is never glossy; some packs ship roughness far too low (grass ~0.26), which turns
      // the whole field into a sun glint. Only mud may get wet-shiny.
      if (r.rough) albedo[o + p + 3] = Math.round((minRough + (r.rough[p] / 255) * (1 - minRough)) * 255);
      if (r.normal) {
        detail[o + p] = r.normal[p];
        // OpenGL-convention normal maps (+Y up), which is what most CC0 packs ship.
        detail[o + p + 1] = r.normal[p + 1];
      }
    }
  });
  fallback.albedo.dispose();
  fallback.detail.dispose();
  return { albedo: makeArray(albedo, size, true), detail: makeArray(detail, size, false) };
}
