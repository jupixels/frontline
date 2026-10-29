/**
 * Uniform-grid spatial hash rebuilt every tick. Buckets are singly linked lists in typed arrays,
 * so a rebuild allocates nothing. Query order is deterministic (it only depends on insert order).
 */
export class SpatialHash<T extends { pos: { x: number; z: number } }> {
  readonly cols: number;
  private readonly heads: Int32Array;
  private next = new Int32Array(256);
  private items: T[] = [];

  constructor(
    private readonly half: number,
    private readonly cellSize: number,
  ) {
    this.cols = Math.ceil((half * 2) / cellSize);
    this.heads = new Int32Array(this.cols * this.cols).fill(-1);
  }

  private cell(v: number): number {
    const c = Math.floor((v + this.half) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  clear(): void {
    this.heads.fill(-1);
    this.items.length = 0;
  }

  insert(item: T): void {
    const i = this.items.length;
    this.items.push(item);
    if (i >= this.next.length) {
      const n = new Int32Array(this.next.length * 2);
      n.set(this.next);
      this.next = n;
    }
    const c = this.cell(item.pos.z) * this.cols + this.cell(item.pos.x);
    this.next[i] = this.heads[c];
    this.heads[c] = i;
  }

  /** Calls `fn` for every item whose position is within `r` of (x, z). Return true from fn to stop. */
  query(x: number, z: number, r: number, fn: (item: T, d2: number) => boolean | void): void {
    const x0 = this.cell(x - r);
    const x1 = this.cell(x + r);
    const z0 = this.cell(z - r);
    const z1 = this.cell(z + r);
    const r2 = r * r;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let i = this.heads[cz * this.cols + cx]; i >= 0; i = this.next[i]) {
          const it = this.items[i];
          const dx = it.pos.x - x;
          const dz = it.pos.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2 && fn(it, d2) === true) return;
        }
      }
    }
  }
}
