// One deterministic terrain shared by sim/ and render/. The sim samples it on its nav and fog grids
// (passability, height, line of sight, cover); the renderer builds its mesh, water and foliage from
// the same functions, so what you see is exactly what the sim plays on.
//
// Only + - * / Math.sqrt/abs/floor/min/max/imul here (see CONTRIBUTING.md): every peer must get
// bit-identical heights.

import type { Vec2 } from './types';

/** Sea level in meters. Water is drawn at this height everywhere. */
export const WATER_LEVEL = 0;
/** Ground below this is deep water: ships only. Between this and WATER_LEVEL it's fordable shallows. */
export const DEEP_WATER = -1.2;
/** Rise over run between neighboring nav cells above which ground can't climb (a cliff). */
export const CLIFF_SLOPE = 0.9;
/** Trees in forests block sight up to this height above the ground. */
export const TREE_HEIGHT = 11;

export type MapShape =
  | { shape: 'rect'; x: number; z: number; w: number; d: number }
  | { shape: 'circle'; x: number; z: number; r: number }
  /** Closed polygon, points as [x, z]. */
  | { shape: 'poly'; points: [number, number][] };

export interface TerrainHill {
  x: number;
  z: number;
  /** Radius in meters where the hill meets the plain. */
  r: number;
  /** Height above the surrounding ground in meters. */
  h: number;
  /** 0..1: fraction of the radius that is a flat top (0 = round hill, 0.6 = mesa-like plateau). */
  plateau?: number;
}

export interface TerrainRidge {
  points: [number, number][];
  /** Full width at the base in meters. */
  width: number;
  h: number;
  /** Sheer sides: ground units can't climb it (gaps in the polyline make passes). */
  cliff?: boolean;
}

export interface TerrainRiver {
  points: [number, number][];
  /** Width of the water in meters. */
  width: number;
  /** Bed depth below sea level (default 3, deep enough to block ground units). */
  depth?: number;
}

export interface TerrainBridge {
  a: [number, number];
  b: [number, number];
  /** Deck width in meters (default 10). */
  width?: number;
}

export interface TerrainRoad {
  points: [number, number][];
  /** Default 7. */
  width?: number;
}

/** Shape of the ground. Everything optional except `seed`; omit `MapDef.terrain` for a flat map. */
export interface TerrainDef {
  seed: number;
  /** Ground palette: temperate fields, coastal grass and sand, or desert. */
  style?: 'temperate' | 'coastal' | 'desert';
  /** Base land height in meters (default 5). */
  base?: number;
  /** Amplitude of the large rolling hills (default 7). */
  relief?: number;
  /** Amplitude of small bumps (default 1.2). */
  detail?: number;
  hills?: TerrainHill[];
  ridges?: TerrainRidge[];
  /** Rock outcrops/mesas with sheer sides: impassable. */
  cliffs?: MapShape[];
  /** Sea and lakes. */
  water?: MapShape[];
  rivers?: TerrainRiver[];
  /** Shallow crossings in rivers (circles), passable on foot and by vehicles. */
  fords?: { x: number; z: number; r: number }[];
  /** Woods: block line of sight and give infantry cover. Vehicles drive slowly through them. */
  forests?: MapShape[];
  /** Roads: faster for vehicles and supply trucks. */
  roads?: TerrainRoad[];
  /** Bridges carry ground units over rivers; ships pass under them. */
  bridges?: TerrainBridge[];
  /** What surrounds the playable square: hills (default) or open sea. */
  edge?: 'hills' | 'sea';
}

// --- deterministic noise ---

/** Integer lattice hash → [0, 1). */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function wrapPeriod(i: number, period: number): number {
  return period > 0 ? ((i % period) + period) % period : i;
}

/** Smooth value noise in [0, 1). With `period` > 0 it tiles every `period` lattice cells. */
export function valueNoise(x: number, y: number, seed: number, period = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = wrapPeriod(ix, period);
  const x1 = wrapPeriod(ix + 1, period);
  const y0 = wrapPeriod(iy, period);
  const y1 = wrapPeriod(iy + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal sum of value noise in [0, 1). Tiling period doubles with each octave. */
export function fbm(x: number, y: number, seed: number, octaves: number, period = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, seed + o * 31, period * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1): sharp crests, good for rock cracks and mountain ridges. */
export function ridged(x: number, y: number, seed: number, octaves: number, period = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, seed + o * 17, period * f) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// --- shapes ---

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

/** Distance from (x, z) to a polyline. */
export function polylineDistance(points: readonly [number, number][], x: number, z: number): number {
  if (points.length === 1) return segDist(x, z, points[0][0], points[0][1], points[0][0], points[0][1]);
  let d = Infinity;
  for (let i = 1; i < points.length; i++) {
    const s = segDist(x, z, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    if (s < d) d = s;
  }
  return d;
}

/**
 * Signed distance (meters) from (x, z) to a shape; negative inside. With `half` set, rects that touch
 * the map edge continue outward so edge water reads as open sea rather than a pond.
 */
export function shapeDistance(s: MapShape, x: number, z: number, half = 0): number {
  if (s.shape === 'circle') return Math.sqrt((x - s.x) * (x - s.x) + (z - s.z) * (z - s.z)) - s.r;
  if (s.shape === 'poly') {
    const p = s.points;
    let d = Infinity;
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, zi] = p[i];
      const [xj, zj] = p[j];
      const e = segDist(x, z, xj, zj, xi, zi);
      if (e < d) d = e;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside ? -d : d;
  }
  let x0 = s.x - s.w / 2;
  let x1 = s.x + s.w / 2;
  let z0 = s.z - s.d / 2;
  let z1 = s.z + s.d / 2;
  if (half > 0) {
    if (x1 >= half - 1) x1 = 1e9;
    if (x0 <= -half + 1) x0 = -1e9;
    if (z1 >= half - 1) z1 = 1e9;
    if (z0 <= -half + 1) z0 = -1e9;
  }
  const dx = Math.max(x0 - x, 0, x - x1);
  const dz = Math.max(z0 - z, 0, z - z1);
  if (dx > 0 || dz > 0) return Math.sqrt(dx * dx + dz * dz);
  return -Math.min(x - x0, x1 - x, z - z0, z1 - z);
}

function minShapeDistance(shapes: readonly MapShape[], x: number, z: number, half: number): number {
  let d = 1e9;
  for (const s of shapes) {
    const v = shapeDistance(s, x, z, half);
    if (v < d) d = v;
  }
  return d;
}

/** Axis-aligned bounds of a shape: [x0, z0, x1, z1]. */
export function shapeBounds(s: MapShape): [number, number, number, number] {
  if (s.shape === 'circle') return [s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r];
  if (s.shape === 'rect') return [s.x - s.w / 2, s.z - s.d / 2, s.x + s.w / 2, s.z + s.d / 2];
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of s.points) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

/** The parts of a map the terrain needs (MapDef satisfies this). */
export interface TerrainSource {
  size: number;
  terrain?: TerrainDef;
  /** Legacy top-level shapes (Phase 1 maps): water basins and impassable rocks. */
  water?: MapShape[];
  obstacles?: MapShape[];
}

/**
 * The terrain of one map: heights, water, forests, roads and bridges. Pure functions of the map
 * definition, identical on every peer and in the renderer.
 */
export class TerrainModel {
  readonly half: number;
  readonly flat: boolean;
  readonly style: 'temperate' | 'coastal' | 'desert';
  readonly def: Required<Pick<TerrainDef, 'seed' | 'base' | 'relief' | 'detail'>> & TerrainDef;
  readonly water: MapShape[];
  readonly cliffs: MapShape[];
  readonly forests: MapShape[];
  readonly bridges: TerrainBridge[];
  readonly roads: TerrainRoad[];

  constructor(readonly map: TerrainSource) {
    this.half = map.size / 2;
    const t = map.terrain;
    this.flat = !t;
    this.def = { base: 5, relief: 7, detail: 1.2, ...(t ?? { seed: 1 }) };
    this.style = t?.style ?? 'temperate';
    this.water = [...(t?.water ?? []), ...(map.water ?? [])];
    this.cliffs = [...(t?.cliffs ?? []), ...(map.obstacles ?? [])];
    this.forests = t?.forests ?? [];
    this.bridges = t?.bridges ?? [];
    this.roads = t?.roads ?? [];
  }

  /**
   * Ground height in meters at (x, z) (river beds and sea floor included; bridges are not).
   * Outside the playable square it keeps going (rim hills or sea) for the renderer's scenery.
   */
  height(x: number, z: number): number {
    const d = this.def;
    const half = this.half;
    const seed = d.seed;
    if (this.flat) return this.water.length || this.cliffs.length ? this.shapedFlat(x, z) : d.base;
    let h = d.base + (fbm(x / 260, z / 260, seed, 4) - 0.5) * 2 * d.relief + (fbm(x / 50, z / 50, seed + 7, 3) - 0.5) * 2 * d.detail;
    // Random relief never makes puddles: keep land comfortably above the water line.
    if (h < 1.6) h = 1.6 - (1.6 - h) * 0.15;

    for (const hl of d.hills ?? []) {
      const dx = x - hl.x;
      const dz = z - hl.z;
      const dd = dx * dx + dz * dz;
      if (dd >= hl.r * hl.r) continue;
      const dist = Math.sqrt(dd);
      const p = hl.plateau ?? 0;
      const t = smoothstep(hl.r, hl.r * p, dist);
      h += hl.h * t * (0.92 + 0.16 * valueNoise(x / 30, z / 30, seed + 41));
    }
    for (const r of d.ridges ?? []) {
      const dist = polylineDistance(r.points, x, z);
      const w = r.width / 2;
      if (dist >= w) continue;
      const t = r.cliff ? smoothstep(w, w - 7, dist) : smoothstep(w, 0, dist);
      h += r.h * t * (0.8 + 0.4 * ridged(x / 40, z / 40, seed + 23, 2));
    }
    if (this.cliffs.length) {
      const cd = minShapeDistance(this.cliffs, x, z, 0);
      if (cd < 6) h += smoothstep(6, -3, cd) * (7 + ridged(x / 14, z / 14, seed + 9, 3) * 7);
    }

    // Rivers carve a channel; fords raise the bed to wading depth.
    for (const rv of d.rivers ?? []) {
      const dist = polylineDistance(rv.points, x, z);
      const w = rv.width / 2;
      if (dist >= w + 14) continue;
      let bed = -(rv.depth ?? 3) + (valueNoise(x / 20, z / 20, seed + 51) - 0.5) * 0.6;
      for (const f of d.fords ?? []) {
        const fd = Math.sqrt((x - f.x) * (x - f.x) + (z - f.z) * (z - f.z));
        if (fd < f.r) bed = lerp(bed, -0.55, smoothstep(f.r, f.r * 0.45, fd));
      }
      h = lerp(h, bed, smoothstep(w + 14, w - 1, dist));
    }

    // Rim beyond the playable square.
    const ax = x < 0 ? -x : x;
    const az = z < 0 ? -z : z;
    const out = (ax > az ? ax : az) - half;
    const seaEdge = d.edge === 'sea';
    let sea = 0;
    let floor = 0;
    if (this.water.length || seaEdge) {
      let wd = this.water.length ? minShapeDistance(this.water, x, z, half) : 1e9;
      if (seaEdge) wd = Math.min(wd, -out + 40);
      sea = smoothstep(10, -16, wd);
      floor = -3 - smoothstep(0, -70, wd) * 6 + (fbm(x / 40, z / 40, seed + 12, 2) - 0.5) * 1.5;
    }
    if (!seaEdge) {
      let rim = smoothstep(-30, 180, out);
      if (this.water.length) rim *= smoothstep(20, 120, minShapeDistance(this.water, x, z, half));
      if (rim > 0) h += rim * (10 + ridged(x / 160, z / 160, seed + 3, 4) * 70 + fbm(x / 70, z / 70, seed + 4, 3) * 12);
    }
    return sea > 0 ? lerp(h, floor, sea) : h;
  }

  /** Flat map with legacy water/rock shapes (sandbox-style test maps). */
  private shapedFlat(x: number, z: number): number {
    let h = this.def.base;
    if (this.cliffs.length) {
      const cd = minShapeDistance(this.cliffs, x, z, 0);
      if (cd < 6) h += smoothstep(6, -3, cd) * 9;
    }
    if (this.water.length) {
      const wd = minShapeDistance(this.water, x, z, this.half);
      h = lerp(h, -4 - smoothstep(0, -60, wd) * 5, smoothstep(8, -12, wd));
    }
    return h;
  }

  /** True inside an impassable rock shape. */
  isCliff(x: number, z: number): boolean {
    return this.cliffs.length > 0 && minShapeDistance(this.cliffs, x, z, 0) < 0;
  }

  isForest(x: number, z: number): boolean {
    return this.forests.length > 0 && minShapeDistance(this.forests, x, z, 0) < 0;
  }

  isRoad(x: number, z: number): boolean {
    for (const r of this.roads) if (polylineDistance(r.points, x, z) < (r.width ?? 7) / 2) return true;
    return false;
  }

  /** Bridge deck height at (x, z), or null when not on a bridge. */
  bridgeDeck(x: number, z: number): number | null {
    for (const b of this.bridges) {
      const w = (b.width ?? 10) / 2;
      if (segDist(x, z, b.a[0], b.a[1], b.b[0], b.b[1]) > w) continue;
      // Exclude the round caps past the ends.
      const dx = b.b[0] - b.a[0];
      const dz = b.b[1] - b.a[1];
      const t = ((x - b.a[0]) * dx + (z - b.a[1]) * dz) / (dx * dx + dz * dz);
      if (t < 0 || t > 1) continue;
      return this.deckHeight(b);
    }
    return null;
  }

  /** Bridges are level, slightly above the higher bank. */
  deckHeight(b: TerrainBridge): number {
    return Math.max(this.height(b.a[0], b.a[1]), this.height(b.b[0], b.b[1]), 1.5) + 0.6;
  }

  /** Where ground units stand: bridge deck, else the ground (fords included). */
  surface(x: number, z: number): number {
    const deck = this.bridges.length ? this.bridgeDeck(x, z) : null;
    return deck ?? this.height(x, z);
  }

  /** Median-ish reference height of the playable area (high-ground bonuses are relative to it). */
  baseline(): number {
    return this.def.base;
  }
}

/** Distance along a polyline from its start to the point nearest `p` (for road/river UI). */
export function nearestOnPolyline(points: readonly [number, number][], p: Vec2): Vec2 {
  let best = { x: points[0][0], z: points[0][1] };
  let bestD = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((p.x - ax) * dx + (p.z - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const q = { x: ax + dx * t, z: az + dz * t };
    const d = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}
