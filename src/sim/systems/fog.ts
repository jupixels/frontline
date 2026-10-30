import { TREE_HEIGHT } from '../../shared/terrain';
import type { EntityId, PlayerId, TeamId } from '../../shared/types';
import { FOG_EXPLORED, FOG_UNEXPLORED, FOG_VISIBLE, type FogView } from '../contracts';
import { FLAG_FOREST } from '../path/navgrid';
import { hiddenFrom } from './abilities';
import type { Entity, World } from '../world';

/** Height above the ground a viewer sees from. */
export function eyeHeight(e: Entity): number {
  if (e.kind === 'structure') return e.type === 'watchtower' || e.type === 'radar' ? 14 : 6;
  if (e.domain === 'air') return 40;
  if (e.domain === 'naval') return 8;
  return e.armor === 'infantry' ? 1.8 : 2.6;
}

/** Visible cells are judged at this height above their ground (a standing soldier). */
const TARGET_HEIGHT = 1.6;
/** Cache size cap for line-of-sight footprints. */
const MAX_CACHED = 6000;

/**
 * Per-team visibility grids, recomputed every `fogUpdateTicks`. On maps with relief or forests,
 * sight is traced cell by cell: ridges, hills and woods cast shadows, and high ground sees farther.
 */
export class FogOfWar implements FogView {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  version = 0;
  private readonly half: number;
  private readonly grids = new Map<TeamId, Uint8Array>();
  /** Cached disc offsets per radius in cells. */
  private readonly discs = new Map<number, Int32Array>();
  private readonly empty: Uint8Array;
  /** Ground height per fog cell (sea level over water). */
  readonly ground: Float64Array;
  /** Height that blocks sight per fog cell (ground, plus trees in forests). */
  readonly block: Float64Array;
  /** False on flat, treeless maps: plain discs, no tracing. */
  readonly traced: boolean;
  private readonly footprints = new Map<number, Int32Array>();
  private readonly stamp: Int32Array;
  private gen = 0;

  constructor(private readonly world: World) {
    const size = world.map.size;
    this.cellSize = world.content.rules.fogCellSize;
    this.cols = Math.ceil(size / this.cellSize);
    this.rows = this.cols;
    this.half = size / 2;
    const n = this.cols * this.rows;
    this.empty = new Uint8Array(n);
    this.ground = new Float64Array(n);
    this.block = new Float64Array(n);
    this.stamp = new Int32Array(n);
    for (const t of world.teams.keys()) this.grids.set(t, new Uint8Array(n));
    const nav = world.nav;
    let min = Infinity;
    let max = -Infinity;
    let forest = false;
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = cz * this.cols + cx;
        const x = (cx + 0.5) * this.cellSize - this.half;
        const z = (cz + 0.5) * this.cellSize - this.half;
        const h = Math.max(0, nav.heightAt(x, z));
        this.ground[i] = h;
        const f = (nav.flagsAt({ x, z }) & FLAG_FOREST) !== 0;
        if (f) forest = true;
        this.block[i] = h + (f ? TREE_HEIGHT : 0);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    this.traced = forest || max - min > 1.5;
  }

  private disc(r: number): Int32Array {
    let d = this.discs.get(r);
    if (d) return d;
    const out: number[] = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) out.push(dx, dz);
    d = Int32Array.from(out);
    this.discs.set(r, d);
    return d;
  }

  private cellIndex(x: number, z: number): number {
    const cx = Math.floor((x + this.half) / this.cellSize);
    const cz = Math.floor((z + this.half) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return cz * this.cols + cx;
  }

  /** Ground height of the fog cell at (x, z). */
  groundAt(x: number, z: number): number {
    const i = this.cellIndex(x, z);
    return i < 0 ? 0 : this.ground[i];
  }

  /**
   * Line of sight between two points at the given heights above their ground. Woods block beyond the
   * first cell (you can see into, and out of, the edge of a forest); terrain blocks everywhere.
   */
  lineOfSight(ax: number, az: number, aEye: number, bx: number, bz: number, bTop: number): boolean {
    if (!this.traced) return true;
    const cs = this.cellSize;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < cs * 1.5) return true;
    const eye = this.groundAt(ax, az) + aEye;
    const top = this.groundAt(bx, bz) + bTop;
    const steps = Math.ceil(len / (cs * 0.5));
    const ia = this.cellIndex(ax, az);
    const ib = this.cellIndex(bx, bz);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const i = this.cellIndex(ax + dx * t, az + dz * t);
      if (i < 0 || i === ia || i === ib) continue;
      const d = t * len;
      // Trees right next to either end don't block (edge of the woods).
      const h = d < cs * 1.5 || len - d < cs * 1.5 ? this.ground[i] : this.block[i];
      if (h > eye + (top - eye) * t) return false;
    }
    return true;
  }

  /** Sight range in meters after the high-ground bonus (up to +25% well above the map's base height). */
  sightOf(e: Entity): number {
    if (!this.traced || e.domain === 'air') return e.sight;
    const above = this.groundAt(e.pos.x, e.pos.z) - this.world.nav.model.baseline();
    return e.sight * (1 + Math.min(0.25, Math.max(0, above * 0.008)));
  }

  /** Cells visible from cell (cx, cz) with eye height `eye` out to `r` cells, as offset pairs. */
  private footprint(cx: number, cz: number, r: number, eye: number): Int32Array {
    const eyeClass = Math.round(eye);
    const key = (cz * this.cols + cx) * 4096 + r * 64 + eyeClass;
    let fp = this.footprints.get(key);
    if (fp) return fp;
    if (this.footprints.size > MAX_CACHED) this.footprints.clear();
    const { cols, rows, cellSize } = this;
    const gen = ++this.gen;
    const out: number[] = [0, 0];
    const center = cz * cols + cx;
    this.stamp[center] = gen;
    const eyeH = this.ground[center] + eyeClass;
    const disc = this.disc(r);
    const r2 = r * r;
    const inner = (r - 1) * (r - 1);
    for (let k = 0; k < disc.length; k += 2) {
      const ex = disc[k];
      const ez = disc[k + 1];
      if (ex * ex + ez * ez <= inner) continue; // rays go to the rim only
      const steps = Math.max(Math.abs(ex), Math.abs(ez));
      let maxSlope = -Infinity;
      for (let s = 1; s <= steps; s++) {
        const ox = Math.round((ex * s) / steps);
        const oz = Math.round((ez * s) / steps);
        if (ox * ox + oz * oz > r2) break;
        const x = cx + ox;
        const z = cz + oz;
        if (x < 0 || z < 0 || x >= cols || z >= rows) break;
        const i = z * cols + x;
        const dist = Math.sqrt(ox * ox + oz * oz) * cellSize;
        const tgt = (this.ground[i] + TARGET_HEIGHT - eyeH) / dist;
        if (tgt >= maxSlope && this.stamp[i] !== gen) {
          this.stamp[i] = gen;
          out.push(ox, oz);
        }
        // The first two cells out never block, so units see a little way into woods they stand in.
        const blk = ((s <= 2 ? this.ground[i] : this.block[i]) - eyeH) / dist;
        if (blk > maxSlope) maxSlope = blk;
      }
    }
    fp = Int32Array.from(out);
    this.footprints.set(key, fp);
    return fp;
  }

  /** Cells covered by smoke this update (null when there is none). */
  private smokeMask(): Uint8Array | null {
    const smokes = this.world.smokes;
    if (smokes.length === 0) return null;
    const m = new Uint8Array(this.cols * this.rows);
    for (const s of smokes) {
      const r = Math.ceil(s.radius / this.cellSize);
      const cx = Math.floor((s.at.x + this.half) / this.cellSize);
      const cz = Math.floor((s.at.z + this.half) / this.cellSize);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
          const wx = (x + 0.5) * this.cellSize - this.half - s.at.x;
          const wz = (z + 0.5) * this.cellSize - this.half - s.at.z;
          if (wx * wx + wz * wz <= s.radius * s.radius) m[z * this.cols + x] = 1;
        }
      }
    }
    return m;
  }

  update(): void {
    for (const g of this.grids.values()) for (let i = 0; i < g.length; i++) if (g[i] === FOG_VISIBLE) g[i] = FOG_EXPLORED;
    const { cols, rows } = this;
    const smoke = this.smokeMask();
    for (const e of this.world.entities.values()) {
      // Passengers see nothing; garrisons see from their building (which has its own sight).
      if (e.dead || e.sight <= 0 || e.team < 0 || e.inside) continue;
      const g = this.grids.get(e.team);
      if (!g) continue;
      const cx = Math.floor((e.pos.x + this.half) / this.cellSize);
      const cz = Math.floor((e.pos.z + this.half) / this.cellSize);
      const r = Math.round(this.sightOf(e) / this.cellSize);
      const inMap = cx >= 0 && cz >= 0 && cx < cols && cz < rows;
      const d = this.traced && e.domain !== 'air' && inMap ? this.footprint(cx, cz, r, eyeHeight(e)) : this.disc(r);
      for (let k = 0; k < d.length; k += 2) {
        const x = cx + d[k];
        const z = cz + d[k + 1];
        if (x < 0 || z < 0 || x >= cols || z >= rows) continue;
        // Smoke hides what's inside it from anyone more than a cell away.
        if (smoke && smoke[z * cols + x] && d[k] * d[k] + d[k + 1] * d[k + 1] > 2) continue;
        g[z * cols + x] = FOG_VISIBLE;
      }
    }
    this.version++;
  }

  private teamGrid(player: PlayerId): Uint8Array | undefined {
    return this.grids.get(this.world.teamOf(player));
  }

  cells(player: PlayerId): Readonly<Uint8Array> {
    return this.teamGrid(player) ?? this.empty;
  }

  teamVisible(team: TeamId, x: number, z: number): boolean {
    const g = this.grids.get(team);
    const i = this.cellIndex(x, z);
    return !!g && i >= 0 && g[i] === FOG_VISIBLE;
  }

  isVisible(player: PlayerId, x: number, z: number): boolean {
    return this.teamVisible(this.world.teamOf(player), x, z);
  }

  isExplored(player: PlayerId, x: number, z: number): boolean {
    const g = this.teamGrid(player);
    const i = this.cellIndex(x, z);
    return !!g && i >= 0 && g[i] !== FOG_UNEXPLORED;
  }

  canSee(player: PlayerId, id: EntityId): boolean {
    const e = this.world.entities.get(id);
    if (!e) return false;
    if (e.kind === 'point' || e.team < 0) return true;
    const team = this.world.teamOf(player);
    if (e.team === team) return true;
    if (e.inside) return false;
    return this.teamVisible(team, e.pos.x, e.pos.z) && !hiddenFrom(this.world, e, team);
  }
}
