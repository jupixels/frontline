import * as THREE from 'three';
import type { UnitDef } from '../shared/data';
import { FOG_EXPLORED, FOG_VISIBLE, type FogView, type SimView } from '../shared/entities';
import type { PlayerId, PlayerSlot } from '../shared/types';

/**
 * Where the renderer gets fog-of-war visibility from: the sim's fog (`SimFogSource`) in a match,
 * or a local stand-in when the sim has none.
 */
export interface VisibilitySource {
  /** Grid cells per side. */
  readonly resolution: number;
  /** World meters covered by the square grid, starting at (origin, origin). */
  readonly worldSize: number;
  readonly origin: number;
  /** Recompute visibility from the current sim state. */
  update(sim: SimView): void;
  /** 0..255 visibility now (soft edges allowed). Row-major, row 0 at minimum z. */
  readonly visible: Uint8Array;
  /** 0..255, the most this cell has ever been visible. */
  readonly explored: Uint8Array;
}

/** Width of the soft edge at the rim of a unit's sight circle, in meters. */
const EDGE = 8;

/** Fallback when the sim offers no fog (tests, old sims): circles of `def.sight` around own/allied units. */
export class LocalVisionSource implements VisibilitySource {
  readonly visible: Uint8Array;
  readonly explored: Uint8Array;
  readonly worldSize: number;
  readonly origin: number;
  private readonly allies = new Set<PlayerId>();

  constructor(
    readonly resolution: number,
    private readonly mapSize: number,
    private readonly units: Record<string, UnitDef>,
    players: PlayerSlot[],
    localPlayer: PlayerId,
  ) {
    this.worldSize = mapSize;
    this.origin = -mapSize / 2;
    this.visible = new Uint8Array(resolution * resolution);
    this.explored = new Uint8Array(resolution * resolution);
    const team = players.find((p) => p.id === localPlayer)?.team;
    for (const p of players) if (p.id === localPlayer || (team !== undefined && p.team === team)) this.allies.add(p.id);
  }

  update(sim: SimView): void {
    const n = this.resolution;
    const cell = this.mapSize / n;
    const half = this.mapSize / 2;
    this.visible.fill(0);
    for (const e of sim.entities()) {
      if (!this.allies.has(e.owner)) continue;
      const sight = this.units[e.type]?.sight ?? 0;
      if (sight <= 0) continue;
      const cx = (e.pos.x + half) / cell;
      const cz = (e.pos.z + half) / cell;
      const r = sight / cell;
      const r2 = r * r;
      const edge = EDGE / cell;
      const z0 = Math.max(0, Math.floor(cz - r));
      const z1 = Math.min(n - 1, Math.ceil(cz + r));
      for (let z = z0; z <= z1; z++) {
        const dz = z + 0.5 - cz;
        const span = r2 - dz * dz;
        if (span < 0) continue;
        const w = Math.sqrt(span);
        const x0 = Math.max(0, Math.floor(cx - w));
        const x1 = Math.min(n - 1, Math.ceil(cx + w));
        const row = z * n;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx;
          const k = Math.min(1, (r - Math.sqrt(dx * dx + dz * dz)) / edge);
          if (k <= 0) continue;
          const v = (k * 255) | 0;
          const i = row + x;
          if (v > this.visible[i]) this.visible[i] = v;
          if (v > this.explored[i]) this.explored[i] = v;
        }
      }
    }
  }
}

/**
 * The sim's deterministic fog of war (`SimViewExt.fog`), seen from one player. FOG_VISIBLE cells are
 * visible, FOG_EXPLORED and up are explored; the renderer smooths and blurs the hard cell edges.
 */
export class SimFogSource implements VisibilitySource {
  readonly resolution: number;
  readonly worldSize: number;
  readonly origin: number;
  readonly visible: Uint8Array;
  readonly explored: Uint8Array;
  private version = -1;

  constructor(
    private readonly fog: FogView,
    private readonly player: PlayerId,
    mapSize: number,
  ) {
    // Grid cell (0,0) is the map's -x,-z corner.
    this.origin = -mapSize / 2;
    this.resolution = Math.max(fog.cols, fog.rows);
    this.worldSize = this.resolution * fog.cellSize;
    this.visible = new Uint8Array(this.resolution * this.resolution);
    this.explored = new Uint8Array(this.resolution * this.resolution);
  }

  update(): void {
    if (this.fog.version === this.version) return;
    this.version = this.fog.version;
    const cells = this.fog.cells(this.player);
    const { cols, rows } = this.fog;
    const n = this.resolution;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = cells[r * cols + c];
        this.visible[r * n + c] = v >= FOG_VISIBLE ? 255 : 0;
        this.explored[r * n + c] = v >= FOG_EXPLORED ? 255 : 0;
      }
    }
  }
}

const UPDATE_EVERY = 0.1;

/**
 * Turns a VisibilitySource into a smoothly animated RG texture (R = visible, G = explored) for the
 * fog post effect, and answers point queries for hiding enemy units and effects.
 */
export class FogOfWar {
  readonly texture: THREE.DataTexture;
  /** (minX, minZ, size, size) of the grid in world meters; shared with the post effect. */
  readonly bounds = new THREE.Vector4();
  enabled = true;
  private current = new Float32Array(0);
  private data = new Uint8Array(0);
  private timer = UPDATE_EVERY;
  private source!: VisibilitySource;

  constructor(source: VisibilitySource) {
    this.texture = new THREE.DataTexture(new Uint8Array(2), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.setSource(source);
  }

  setSource(source: VisibilitySource): void {
    this.source = source;
    const n = source.resolution;
    if (this.data.length !== n * n * 2) {
      this.current = new Float32Array(n * n * 2);
      this.data = new Uint8Array(n * n * 2);
      this.texture.dispose();
      this.texture.image = { data: this.data, width: n, height: n };
    }
    this.bounds.set(source.origin, source.origin, source.worldSize, source.worldSize);
    this.timer = UPDATE_EVERY;
    this.texture.needsUpdate = true;
  }

  update(sim: SimView, dt: number): void {
    this.timer += dt;
    if (this.timer >= UPDATE_EVERY) {
      this.timer = 0;
      this.source.update(sim);
    }
    const vis = this.source.visible;
    const exp = this.source.explored;
    const cur = this.current;
    const k = Math.min(1, dt * 4);
    let changed = false;
    for (let i = 0, j = 0; i < vis.length; i++, j += 2) {
      const tv = vis[i] / 255;
      const te = exp[i] / 255;
      const v = cur[j] + (tv - cur[j]) * k;
      const e = cur[j + 1] + (te - cur[j + 1]) * k;
      cur[j] = v;
      cur[j + 1] = e;
      const bv = (v * 255 + 0.5) | 0;
      const be = (e * 255 + 0.5) | 0;
      if (bv !== this.data[j] || be !== this.data[j + 1]) {
        this.data[j] = bv;
        this.data[j + 1] = be;
        changed = true;
      }
    }
    if (changed) this.texture.needsUpdate = true;
  }

  private cellIndex(x: number, z: number): number {
    const n = this.source.resolution;
    const size = this.source.worldSize;
    const o = this.source.origin;
    const i = Math.floor(((x - o) / size) * n);
    const j = Math.floor(((z - o) / size) * n);
    return i < 0 || j < 0 || i >= n || j >= n ? -1 : j * n + i;
  }

  /** True when (x, z) is currently visible to the local player (always true with fog disabled). */
  isVisible(x: number, z: number): boolean {
    if (!this.enabled) return true;
    const i = this.cellIndex(x, z);
    return i >= 0 && this.source.visible[i] > 127;
  }

  isExplored(x: number, z: number): boolean {
    if (!this.enabled) return true;
    const i = this.cellIndex(x, z);
    return i >= 0 && this.source.explored[i] > 127;
  }
}
