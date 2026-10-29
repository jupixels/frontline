import type { EntityId, PlayerId, TeamId } from '../../shared/types';
import { FOG_EXPLORED, FOG_UNEXPLORED, FOG_VISIBLE, type FogView } from '../contracts';
import type { World } from '../world';

/** Per-team visibility grids, recomputed every `fogUpdateTicks`. */
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

  constructor(private readonly world: World) {
    const size = world.map.size;
    this.cellSize = world.content.rules.fogCellSize;
    this.cols = Math.ceil(size / this.cellSize);
    this.rows = this.cols;
    this.half = size / 2;
    this.empty = new Uint8Array(this.cols * this.rows);
    for (const t of world.teams.keys()) this.grids.set(t, new Uint8Array(this.cols * this.rows));
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

  update(): void {
    for (const g of this.grids.values()) for (let i = 0; i < g.length; i++) if (g[i] === FOG_VISIBLE) g[i] = FOG_EXPLORED;
    const { cols, rows } = this;
    for (const e of this.world.entities.values()) {
      if (e.dead || e.sight <= 0 || e.team < 0) continue;
      const g = this.grids.get(e.team);
      if (!g) continue;
      const cx = Math.floor((e.pos.x + this.half) / this.cellSize);
      const cz = Math.floor((e.pos.z + this.half) / this.cellSize);
      const d = this.disc(Math.round(e.sight / this.cellSize));
      for (let k = 0; k < d.length; k += 2) {
        const x = cx + d[k];
        const z = cz + d[k + 1];
        if (x < 0 || z < 0 || x >= cols || z >= rows) continue;
        g[z * cols + x] = FOG_VISIBLE;
      }
    }
    this.version++;
  }

  private teamGrid(player: PlayerId): Uint8Array | undefined {
    return this.grids.get(this.world.teamOf(player));
  }

  private index(x: number, z: number): number {
    const cx = Math.floor((x + this.half) / this.cellSize);
    const cz = Math.floor((z + this.half) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return cz * this.cols + cx;
  }

  cells(player: PlayerId): Readonly<Uint8Array> {
    return this.teamGrid(player) ?? this.empty;
  }

  teamVisible(team: TeamId, x: number, z: number): boolean {
    const g = this.grids.get(team);
    const i = this.index(x, z);
    return !!g && i >= 0 && g[i] === FOG_VISIBLE;
  }

  isVisible(player: PlayerId, x: number, z: number): boolean {
    return this.teamVisible(this.world.teamOf(player), x, z);
  }

  isExplored(player: PlayerId, x: number, z: number): boolean {
    const g = this.teamGrid(player);
    const i = this.index(x, z);
    return !!g && i >= 0 && g[i] !== FOG_UNEXPLORED;
  }

  canSee(player: PlayerId, id: EntityId): boolean {
    const e = this.world.entities.get(id);
    if (!e) return false;
    if (e.kind === 'point' || e.team < 0) return true;
    const team = this.world.teamOf(player);
    if (e.team === team) return true;
    return this.teamVisible(team, e.pos.x, e.pos.z);
  }
}
