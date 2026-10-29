import type { Domain } from '../../shared/data';
import type { Vec2 } from '../../shared/types';
import type { NavGrid } from './navgrid';

const UNREACHABLE = 0x3fffffff;
const STRAIGHT = 10;
const DIAGONAL = 14;
/** Extra cost for cells next to a wall, so wide vehicles keep some clearance. */
const NEAR_WALL = 8;

/**
 * Integration field toward one goal cell (Dijkstra over 8-neighbours, no corner cutting).
 * Units descend it to reach the goal; any number of units can share one field.
 */
export class FlowField {
  readonly cost: Int32Array;
  readonly version: number;

  constructor(
    readonly grid: NavGrid,
    readonly domain: Domain,
    readonly goal: number,
  ) {
    this.version = grid.version;
    const n = grid.cols * grid.rows;
    this.cost = new Int32Array(n).fill(UNREACHABLE);
    this.build();
  }

  private build(): void {
    const { grid, domain, cost } = this;
    const cols = grid.cols;
    const rows = grid.rows;
    const open = grid.passableMask(domain);
    const wall = grid.nearWallMask(domain);
    // Dial's algorithm: edge costs are small integers, so a ring of buckets replaces the heap.
    // Shortest-path costs are unique, so bucket order can't change the result.
    const buckets = new Buckets(STRAIGHT + DIAGONAL + NEAR_WALL + 1);
    cost[this.goal] = 0;
    buckets.push(this.goal, 0);
    let key = 0;
    while (buckets.size > 0) {
      const c = buckets.pop(key);
      if (c < 0) {
        key++;
        continue;
      }
      if (key > cost[c]) continue;
      const cx = c % cols;
      const cz = (c - cx) / cols;
      for (let dz = -1; dz <= 1; dz++) {
        const nz = cz + dz;
        if (nz < 0 || nz >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= cols) continue;
          const ni = nz * cols + nx;
          if (!open[ni]) continue;
          let step = STRAIGHT;
          if (dx !== 0 && dz !== 0) {
            if (!open[cz * cols + nx] || !open[nz * cols + cx]) continue;
            step = DIAGONAL;
          }
          if (wall[ni]) step += NEAR_WALL;
          const nc = key + step;
          if (nc < cost[ni]) {
            cost[ni] = nc;
            buckets.push(ni, nc);
          }
        }
      }
    }
  }

  reachable(cell: number): boolean {
    return this.cost[cell] < UNREACHABLE;
  }

  /** Neighbour of `cell` with the lowest cost (no corner cutting), or -1 at the goal / unreachable. */
  next(cell: number): number {
    const { grid, cost, domain } = this;
    const cols = grid.cols;
    const cx = cell % cols;
    const cz = (cell - cx) / cols;
    let best = -1;
    let bestCost = cost[cell];
    for (let dz = -1; dz <= 1; dz++) {
      const nz = cz + dz;
      if (nz < 0 || nz >= grid.rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        if (nx < 0 || nx >= cols) continue;
        if (dx !== 0 && dz !== 0 && (!grid.passableCell(cz * cols + nx, domain) || !grid.passableCell(nz * cols + cx, domain))) continue;
        const ni = nz * cols + nx;
        if (cost[ni] < bestCost) {
          bestCost = cost[ni];
          best = ni;
        }
      }
    }
    return best;
  }

  /** A point a few cells down the field from `p` (smooths the 8-direction staircase). */
  lookahead(p: Vec2, steps: number): Vec2 | null {
    let c = this.grid.cellOf(p);
    if (!this.reachable(c)) return null;
    let moved = false;
    for (let i = 0; i < steps; i++) {
      const n = this.next(c);
      if (n < 0) break;
      c = n;
      moved = true;
    }
    if (!moved) return null;
    const cols = this.grid.cols;
    return { x: this.grid.centerX(c % cols), z: this.grid.centerZ(Math.floor(c / cols)) };
  }
}

/** Ring of LIFO buckets keyed by cost modulo the ring size (for Dial's algorithm). */
class Buckets {
  private readonly stacks: Int32Array[];
  private readonly lens: Int32Array;
  size = 0;

  constructor(private readonly ring: number) {
    this.stacks = [];
    for (let i = 0; i < ring; i++) this.stacks.push(new Int32Array(64));
    this.lens = new Int32Array(ring);
  }

  push(cell: number, key: number): void {
    const b = key % this.ring;
    let s = this.stacks[b];
    if (this.lens[b] === s.length) {
      const n = new Int32Array(s.length * 2);
      n.set(s);
      this.stacks[b] = s = n;
    }
    s[this.lens[b]++] = cell;
    this.size++;
  }

  /** Pops a cell from the bucket for `key`, or -1 if it is empty. */
  pop(key: number): number {
    const b = key % this.ring;
    if (this.lens[b] === 0) return -1;
    this.size--;
    return this.stacks[b][--this.lens[b]];
  }
}

/**
 * Shares flow fields between units and commands. Fields are pure functions of (grid, domain, goal),
 * so caching never affects results, only speed. Stale fields (grid changed) are rebuilt on request.
 */
export class FlowFieldCache {
  private readonly fields = new Map<string, FlowField>();
  private readonly order: string[] = [];

  constructor(
    private readonly grid: NavGrid,
    private readonly capacity = 48,
  ) {}

  get(domain: Domain, goal: number): FlowField {
    const key = `${domain}:${goal}`;
    const f = this.fields.get(key);
    if (f && f.version === this.grid.version) return f;
    const nf = new FlowField(this.grid, domain, goal);
    if (!f) {
      this.order.push(key);
      if (this.order.length > this.capacity) this.fields.delete(this.order.shift()!);
    }
    this.fields.set(key, nf);
    return nf;
  }
}
