import * as THREE from 'three';
import type { UnitDef } from '../shared/data';
import type { SimView } from '../shared/entities';
import type { PlayerId, PlayerSlot } from '../shared/types';

/**
 * Where the renderer gets fog-of-war visibility from.
 * TODO(sim): replace `LocalVisionSource` with the sim's fog-of-war API once it lands (the sim should
 * own visibility so it's identical for gameplay and rendering). The renderer only needs "is this
 * point currently visible / ever explored for the local player".
 */
export interface VisibilitySource {
  /** Grid cells per side covering the map square. */
  readonly resolution: number;
  /** Recompute visibility from the current sim state. */
  update(sim: SimView): void;
  /** 1 = visible now, 0 = not. Row-major, row 0 at minimum z. */
  readonly visible: Uint8Array;
  /** 1 = seen at some point. */
  readonly explored: Uint8Array;
}

/** Placeholder: circles of `def.sight` around the local player's (and allies') units. */
export class LocalVisionSource implements VisibilitySource {
  readonly visible: Uint8Array;
  readonly explored: Uint8Array;
  private readonly allies = new Set<PlayerId>();

  constructor(
    readonly resolution: number,
    private readonly mapSize: number,
    private readonly units: Record<string, UnitDef>,
    players: PlayerSlot[],
    localPlayer: PlayerId,
  ) {
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
        this.visible.fill(1, row + x0, row + x1 + 1);
        this.explored.fill(1, row + x0, row + x1 + 1);
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
  readonly bounds: THREE.Vector4;
  enabled = true;
  private readonly current: Float32Array;
  private readonly data: Uint8Array;
  private timer = UPDATE_EVERY;

  constructor(
    private source: VisibilitySource,
    private readonly mapSize: number,
  ) {
    const n = source.resolution;
    this.current = new Float32Array(n * n * 2);
    this.data = new Uint8Array(n * n * 2);
    this.texture = new THREE.DataTexture(this.data, n, n, THREE.RGFormat, THREE.UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.bounds = new THREE.Vector4(-mapSize / 2, -mapSize / 2, mapSize, mapSize);
  }

  setSource(source: VisibilitySource): void {
    this.source = source;
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
      const tv = vis[i];
      const te = exp[i];
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

  /** True when (x, z) is currently visible to the local player (always true with fog disabled). */
  isVisible(x: number, z: number): boolean {
    if (!this.enabled) return true;
    const n = this.source.resolution;
    const i = Math.floor(((x + this.mapSize / 2) / this.mapSize) * n);
    const j = Math.floor(((z + this.mapSize / 2) / this.mapSize) * n);
    if (i < 0 || j < 0 || i >= n || j >= n) return false;
    return this.source.visible[j * n + i] === 1;
  }
}
