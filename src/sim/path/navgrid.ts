import type { Domain } from '../../shared/data';
import { CLIFF_SLOPE, DEEP_WATER, TerrainModel, WATER_LEVEL } from '../../shared/terrain';
import type { Vec2 } from '../../shared/types';
import type { SimMapDef } from '../content';

export const TERRAIN_LAND = 0;
export const TERRAIN_BLOCKED = 1;
export const TERRAIN_WATER = 2;
/** Bridge over water: ground units cross on the deck, ships pass underneath. */
export const TERRAIN_BRIDGE = 3;

/** Per-cell terrain flags (NavGrid.flags). */
export const FLAG_FOREST = 1;
export const FLAG_ROAD = 2;
/** Fordable water: ground units wade slowly. */
export const FLAG_SHALLOW = 4;
export const FLAG_BRIDGE = 8;

/** Axis-aligned cell rectangle, inclusive. */
export interface CellRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * Square passability grid over the map. Cell (0,0) is the map's -x,-z corner.
 * Terrain is fixed per map; structures add occupancy that blocks ground and naval movement.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly half: number;
  readonly terrain: Uint8Array;
  /** Ground height (bridge deck on bridges) at each cell center. */
  readonly heights: Float64Array;
  /** FLAG_* bits per cell. */
  readonly flags: Uint8Array;
  readonly model: TerrainModel;
  /** Number of structures covering each cell. */
  readonly occupancy: Uint8Array;
  /** Bumped whenever occupancy changes so cached flow fields know to rebuild. */
  version = 0;
  private wallMasks = new Map<Domain, { version: number; mask: Uint8Array }>();
  private openMasks = new Map<Domain, { version: number; mask: Uint8Array }>();

  constructor(
    map: SimMapDef,
    readonly cellSize: number,
  ) {
    this.half = map.size / 2;
    this.cols = Math.ceil(map.size / cellSize);
    this.rows = this.cols;
    const n = this.cols * this.rows;
    this.terrain = new Uint8Array(n);
    this.occupancy = new Uint8Array(n);
    this.heights = new Float64Array(n);
    this.flags = new Uint8Array(n);
    this.model = new TerrainModel(map);
    this.classify();
  }

  /** Heights, water, cliffs (sheer slopes and rock shapes), forests, roads and bridges per cell. */
  private classify(): void {
    const m = this.model;
    const { cols, rows } = this;
    const ground = new Float64Array(cols * rows);
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cz * cols + cx;
        const x = this.centerX(cx);
        const z = this.centerZ(cz);
        const h = m.height(x, z);
        ground[i] = h;
        let f = 0;
        if (m.forests.length && m.isForest(x, z)) f |= FLAG_FOREST;
        if (m.roads.length && m.isRoad(x, z)) f |= FLAG_ROAD;
        const deck = m.bridges.length ? m.bridgeDeck(x, z) : null;
        if (deck !== null) {
          f |= FLAG_BRIDGE;
          this.heights[i] = deck;
          this.terrain[i] = h < DEEP_WATER ? TERRAIN_BRIDGE : TERRAIN_LAND;
        } else {
          this.heights[i] = h;
          if (h < DEEP_WATER) this.terrain[i] = TERRAIN_WATER;
          else if (h < WATER_LEVEL - 0.05) f |= FLAG_SHALLOW;
        }
        this.flags[i] = f;
      }
    }
    // Cliffs: rock shapes, and land too steep to climb to any neighbor.
    const limit = CLIFF_SLOPE * this.cellSize;
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cz * cols + cx;
        if (this.terrain[i] !== TERRAIN_LAND || this.flags[i] & FLAG_BRIDGE) continue;
        if (m.cliffs.length && m.isCliff(this.centerX(cx), this.centerZ(cz))) {
          this.terrain[i] = TERRAIN_BLOCKED;
          continue;
        }
        const h = ground[i];
        let steep = false;
        for (let k = 0; k < 4 && !steep; k++) {
          const x = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const z = cz + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (x < 0 || z < 0 || x >= cols || z >= rows) continue;
          const j = z * cols + x;
          if (this.flags[j] & FLAG_BRIDGE) continue;
          const d = ground[j] - h;
          if (d > limit || -d > limit) steep = true;
        }
        if (steep) this.terrain[i] = TERRAIN_BLOCKED;
      }
    }
  }

  private components = new Map<Domain, Int32Array>();

  /** Connected regions of static terrain (structures ignored) for `domain`, labelled per cell. */
  private regions(domain: Domain): Int32Array {
    let comp = this.components.get(domain);
    if (comp) return comp;
    const { cols, rows } = this;
    comp = new Int32Array(cols * rows).fill(-1);
    const open = (i: number) => {
      const t = this.terrain[i];
      return t === TERRAIN_BRIDGE || (domain === 'ground' ? t === TERRAIN_LAND : t === TERRAIN_WATER);
    };
    let label = 0;
    const stack: number[] = [];
    for (let i = 0; i < comp.length; i++) {
      if (comp[i] >= 0 || !open(i)) continue;
      comp[i] = label;
      stack.push(i);
      while (stack.length) {
        const c = stack.pop()!;
        const cx = c % cols;
        const cz = (c - cx) / cols;
        for (let k = 0; k < 4; k++) {
          const x = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const z = cz + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (x < 0 || z < 0 || x >= cols || z >= rows) continue;
          const j = z * cols + x;
          if (comp[j] < 0 && open(j)) {
            comp[j] = label;
            stack.push(j);
          }
        }
      }
      label++;
    }
    this.components.set(domain, comp);
    return comp;
  }

  /** Can `domain` travel from a to b over static terrain? (Nearest open cell to each end.) */
  reachable(domain: Domain, a: Vec2, b: Vec2): boolean {
    if (domain === 'air') return true;
    const comp = this.regions(domain);
    const ia = this.nearestStatic(a, comp);
    const ib = this.nearestStatic(b, comp);
    return ia >= 0 && ib >= 0 && comp[ia] === comp[ib];
  }

  private nearestStatic(p: Vec2, comp: Int32Array): number {
    const cx = this.cellX(p.x);
    const cz = this.cellZ(p.z);
    for (let ring = 0; ring <= 12; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
          const i = z * this.cols + x;
          if (comp[i] >= 0) return i;
        }
      }
    }
    return -1;
  }

  /** Bilinear ground height (bridge decks included) at (x, z). */
  heightAt(x: number, z: number): number {
    const fx = (x + this.half) / this.cellSize - 0.5;
    const fz = (z + this.half) / this.cellSize - 0.5;
    const ix = Math.max(0, Math.min(this.cols - 2, Math.floor(fx)));
    const iz = Math.max(0, Math.min(this.rows - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix));
    const tz = Math.max(0, Math.min(1, fz - iz));
    const c = this.cols;
    const h = this.heights;
    const a = h[iz * c + ix];
    const b = h[iz * c + ix + 1];
    const d = h[(iz + 1) * c + ix];
    const e = h[(iz + 1) * c + ix + 1];
    return a + (b - a) * tx + (d - a) * tz + (a - b - d + e) * tx * tz;
  }

  flagsAt(p: Vec2): number {
    return this.flags[this.cellOf(p)];
  }

  cellX(x: number): number {
    const c = Math.floor((x + this.half) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  cellZ(z: number): number {
    const c = Math.floor((z + this.half) / this.cellSize);
    return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
  }

  cellOf(p: Vec2): number {
    return this.cellZ(p.z) * this.cols + this.cellX(p.x);
  }

  centerX(cx: number): number {
    return (cx + 0.5) * this.cellSize - this.half;
  }

  centerZ(cz: number): number {
    return (cz + 0.5) * this.cellSize - this.half;
  }

  inBounds(p: Vec2): boolean {
    return p.x >= -this.half && p.x < this.half && p.z >= -this.half && p.z < this.half;
  }

  passableCell(i: number, domain: Domain): boolean {
    if (domain === 'air') return true;
    if (this.occupancy[i] > 0) return false;
    const t = this.terrain[i];
    if (t === TERRAIN_BRIDGE) return true;
    return domain === 'ground' ? t === TERRAIN_LAND : t === TERRAIN_WATER;
  }

  passableAt(p: Vec2, domain: Domain): boolean {
    if (domain === 'air') return this.inBounds(p);
    return this.inBounds(p) && this.passableCell(this.cellOf(p), domain);
  }

  /** Cells covered by a structure footprint centered at `at` (w along x, d along z). */
  footprintCells(at: Vec2, w: number, d: number): CellRect {
    const e = 0.001;
    return {
      x0: this.cellX(at.x - w / 2 + e),
      z0: this.cellZ(at.z - d / 2 + e),
      x1: this.cellX(at.x + w / 2 - e),
      z1: this.cellZ(at.z + d / 2 - e),
    };
  }

  /** True if every cell of the rect is open land and the footprint fits inside the map. */
  canPlace(at: Vec2, w: number, d: number, shore: boolean): boolean {
    if (at.x - w / 2 < -this.half || at.x + w / 2 > this.half || at.z - d / 2 < -this.half || at.z + d / 2 > this.half) return false;
    const r = this.footprintCells(at, w, d);
    for (let cz = r.z0; cz <= r.z1; cz++) {
      for (let cx = r.x0; cx <= r.x1; cx++) {
        const i = cz * this.cols + cx;
        if (this.terrain[i] !== TERRAIN_LAND || this.occupancy[i] > 0 || this.flags[i] & (FLAG_SHALLOW | FLAG_BRIDGE)) return false;
      }
    }
    if (!shore) return true;
    // A shore building needs water within two cells of its edge.
    for (let cz = r.z0 - 2; cz <= r.z1 + 2; cz++) {
      for (let cx = r.x0 - 2; cx <= r.x1 + 2; cx++) {
        if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
        if (this.terrain[cz * this.cols + cx] === TERRAIN_WATER) return true;
      }
    }
    return false;
  }

  occupy(r: CellRect, delta: 1 | -1): void {
    for (let cz = r.z0; cz <= r.z1; cz++) {
      for (let cx = r.x0; cx <= r.x1; cx++) {
        const i = cz * this.cols + cx;
        this.occupancy[i] = Math.max(0, this.occupancy[i] + delta);
      }
    }
    this.version++;
  }

  /** Nearest passable cell to `p` for `domain` within `maxRing` cells (ring search), or -1. */
  nearestPassable(p: Vec2, domain: Domain, maxRing = 64): number {
    const cx = this.cellX(p.x);
    const cz = this.cellZ(p.z);
    if (this.passableCell(cz * this.cols + cx, domain)) return cz * this.cols + cx;
    for (let ring = 1; ring <= maxRing; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
          const i = z * this.cols + x;
          if (!this.passableCell(i, domain)) continue;
          const ddx = this.centerX(x) - p.x;
          const ddz = this.centerZ(z) - p.z;
          const d = ddx * ddx + ddz * ddz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Clamp `p` to the nearest passable spot (cell center if it had to move). */
  snap(p: Vec2, domain: Domain): Vec2 {
    const q = { x: Math.max(-this.half + 0.5, Math.min(this.half - 0.5, p.x)), z: Math.max(-this.half + 0.5, Math.min(this.half - 0.5, p.z)) };
    if (this.passableAt(q, domain)) return q;
    const i = this.nearestPassable(q, domain);
    if (i < 0) return q;
    return { x: this.centerX(i % this.cols), z: this.centerZ(Math.floor(i / this.cols)) };
  }

  /** 1 for passable cells. Cached per version. */
  passableMask(domain: Domain): Uint8Array {
    const cached = this.openMasks.get(domain);
    if (cached && cached.version === this.version) return cached.mask;
    const mask = new Uint8Array(this.cols * this.rows);
    for (let i = 0; i < mask.length; i++) mask[i] = this.passableCell(i, domain) ? 1 : 0;
    this.openMasks.set(domain, { version: this.version, mask });
    return mask;
  }

  /** 1 for passable cells that touch an impassable one (or the map edge doesn't count). Cached per version. */
  nearWallMask(domain: Domain): Uint8Array {
    const cached = this.wallMasks.get(domain);
    if (cached && cached.version === this.version) return cached.mask;
    const mask = new Uint8Array(this.cols * this.rows);
    if (domain !== 'air') {
      for (let cz = 0; cz < this.rows; cz++) {
        for (let cx = 0; cx < this.cols; cx++) {
          const i = cz * this.cols + cx;
          if (!this.passableCell(i, domain)) continue;
          search: for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = cx + dx;
              const z = cz + dz;
              if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
              if (!this.passableCell(z * this.cols + x, domain)) {
                mask[i] = 1;
                break search;
              }
            }
          }
        }
      }
    }
    this.wallMasks.set(domain, { version: this.version, mask });
    return mask;
  }

  /** Grid line of sight for movement: every cell the segment crosses is passable. */
  clearLine(a: Vec2, b: Vec2, domain: Domain): boolean {
    if (domain === 'air') return true;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.ceil(len / (this.cellSize * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!this.passableCell(this.cellOf({ x: a.x + dx * t, z: a.z + dz * t }), domain)) return false;
    }
    return true;
  }
}
