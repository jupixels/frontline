import * as THREE from 'three';
import type { UnitDef } from '../shared/data';
import type { SimView } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, PlayerSlot, Vec2 } from '../shared/types';
import type { Picker } from '../shared/view';
import { RtsCamera } from './camera';
import { buildEnvironment } from './environment';
import { UnitView } from './units';

export interface RenderSetup {
  canvas: HTMLCanvasElement;
  mapSize: number;
  units: Record<string, UnitDef>;
  players: PlayerSlot[];
}

/** Draws the sim. Reads SimView + events only; never mutates game state. */
export class GameRenderer implements Picker {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: RtsCamera;
  private readonly ground: THREE.Mesh;
  private readonly views = new Map<EntityId, UnitView>();
  private readonly teamColors = new Map<number, THREE.Color>();
  private readonly raycaster = new THREE.Raycaster();
  private selection = new Set<EntityId>();

  constructor(private readonly setup: RenderSetup) {
    const r = new THREE.WebGLRenderer({ canvas: setup.canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.9;
    this.renderer = r;
    this.cam = new RtsCamera(setup.canvas);
    this.cam.setBounds(setup.mapSize / 2);
    this.ground = buildEnvironment(this.scene, r, setup.mapSize);
    for (const p of setup.players) this.teamColors.set(p.id, new THREE.Color(p.color));
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.cam.resize(innerWidth, innerHeight);
  }

  /** Call right before each sim step so views can interpolate from the old pose. */
  beforeStep(sim: SimView): void {
    for (const e of sim.entities()) this.views.get(e.id)?.capturePrev(e);
  }

  handleEvents(sim: SimView, events: SimEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'spawned') this.ensureView(sim, ev.id);
      else if (ev.type === 'removed') {
        this.views.get(ev.id)?.dispose();
        this.views.delete(ev.id);
      }
    }
  }

  private ensureView(sim: SimView, id: EntityId): UnitView | undefined {
    let v = this.views.get(id);
    if (v) return v;
    const e = sim.get(id);
    const def = e && this.setup.units[e.type];
    if (!e || !def) return undefined;
    v = new UnitView(id, def, this.teamColors.get(e.owner) ?? new THREE.Color('#ffffff'));
    v.capturePrev(e);
    v.setSelected(this.selection.has(id));
    this.scene.add(v.root);
    this.views.set(id, v);
    return v;
  }

  setSelection(ids: Iterable<EntityId>): void {
    this.selection = new Set(ids);
    for (const [id, v] of this.views) v.setSelected(this.selection.has(id));
  }

  /** Render one frame. `alpha` is how far we are between the last two sim ticks. */
  frame(sim: SimView, alpha: number, dt: number): void {
    for (const e of sim.entities()) this.ensureView(sim, e.id)?.update(e, alpha, dt);
    this.cam.update(dt);
    this.renderer.render(this.scene, this.cam.camera);
  }

  // --- Picker ---

  private ndc(sx: number, sy: number): THREE.Vector2 {
    return new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  }

  pickGround(sx: number, sy: number): Vec2 | null {
    this.raycaster.setFromCamera(this.ndc(sx, sy), this.cam.camera);
    const hit = this.raycaster.intersectObject(this.ground, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  pickEntity(sx: number, sy: number): EntityId | null {
    this.raycaster.setFromCamera(this.ndc(sx, sy), this.cam.camera);
    const roots = [...this.views.values()].map((v) => v.root);
    for (const hit of this.raycaster.intersectObjects(roots, true)) {
      const id = hit.object.userData.entityId;
      if (typeof id === 'number') return id;
    }
    // Fall back to the nearest unit footprint around the ground point (small units are hard to click).
    const g = this.pickGround(sx, sy);
    if (!g) return null;
    let best: EntityId | null = null;
    let bestD = Infinity;
    for (const v of this.views.values()) {
      const d = Math.hypot(v.root.position.x - g.x, v.root.position.z - g.z);
      if (d < v.def.radius * 1.5 && d < bestD) {
        best = v.id;
        bestD = d;
      }
    }
    return best;
  }

  entitiesInRect(x0: number, y0: number, x1: number, y1: number): EntityId[] {
    const [lx, hx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ly, hy] = [Math.min(y0, y1), Math.max(y0, y1)];
    const out: EntityId[] = [];
    const p = new THREE.Vector3();
    for (const v of this.views.values()) {
      p.copy(v.root.position).setY(1).project(this.cam.camera);
      const sx = ((p.x + 1) / 2) * innerWidth;
      const sy = ((1 - p.y) / 2) * innerHeight;
      if (p.z < 1 && sx >= lx && sx <= hx && sy >= ly && sy <= hy) out.push(v.id);
    }
    return out;
  }
}
