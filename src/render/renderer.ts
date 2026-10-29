import * as THREE from 'three';
import type { Command } from '../shared/commands';
import type { UnitDef } from '../shared/data';
import type { SimView } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, PlayerId, PlayerSlot, Vec2 } from '../shared/types';
import type { Picker } from '../shared/view';
import { RtsCamera } from './camera';
import { DecalKind, DecalMap } from './decals';
import { Environment } from './environment';
import { FogOfWar, LocalVisionSource, type VisibilitySource } from './fog';
import { InfantryInstancer } from './infantry';
import { CommandMarkers, HealthBars } from './overlay';
import { PostStack } from './post';
import { initialQuality, QUALITY, type QualityLevel, type QualitySettings } from './quality';
import { Terrain, WATER_LEVEL } from './terrain';
import { UnitView } from './units';
import { Vfx, type MuzzleSize } from './vfx';
import { Water } from './water';
import './demo';

export interface RenderSetup {
  canvas: HTMLCanvasElement;
  mapSize: number;
  units: Record<string, UnitDef>;
  players: PlayerSlot[];
  /** Whose eyes the fog of war uses. Defaults to the first human slot. */
  localPlayer?: PlayerId;
  /** Terrain seed. TODO(sim): should come from MapDef once maps carry terrain. */
  terrainSeed?: number;
}

type WeaponKind = 'bullet' | 'cannon' | 'rocket' | 'artillery' | 'bomb';

function weaponKind(weapon: string, shooter?: UnitView): WeaponKind {
  const w = weapon.toLowerCase();
  if (/rocket|missile|atgm|rpg|sam|aam|hellfire|javelin|tow/.test(w)) return 'rocket';
  if (/mortar|artillery|howitzer|arty/.test(w)) return 'artillery';
  if (/bomb/.test(w)) return 'bomb';
  if (/cannon|shell|apfsds|heat|main|tank|autocannon/.test(w)) return 'cannon';
  if (/rifle|mg|machine|bullet|smg|pistol|minigun/.test(w)) return 'bullet';
  return shooter?.def.turretNode ? 'cannon' : 'bullet';
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();

/** Draws the sim. Reads SimView + events only; never mutates game state. */
export class GameRenderer implements Picker {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: RtsCamera;
  readonly terrain: Terrain;
  readonly env: Environment;
  readonly water: Water;
  readonly decals: DecalMap;
  readonly vfx: Vfx;
  readonly fog: FogOfWar;
  private readonly post: PostStack;
  private readonly overlay = new THREE.Scene();
  private readonly healthBars = new HealthBars();
  private readonly markers: CommandMarkers;
  private readonly views = new Map<EntityId, UnitView>();
  private readonly wrecks: UnitView[] = [];
  private readonly infantry = new Map<string, InfantryInstancer>();
  private readonly teamColors = new Map<number, THREE.Color>();
  private readonly allies = new Set<PlayerId>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly rallies = new Map<EntityId, Vec2>();
  private selection = new Set<EntityId>();
  private quality: QualitySettings;
  private localPlayer: PlayerId;
  private time = 0;
  private frameNo = 0;

  constructor(private readonly setup: RenderSetup) {
    this.quality = QUALITY[initialQuality()];
    const r = new THREE.WebGLRenderer({
      canvas: setup.canvas,
      antialias: false, // SMAA in post; MSAA on the default framebuffer would be wasted
      stencil: false,
      powerPreference: 'high-performance',
    });
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.NoToneMapping; // tone mapping happens in post
    this.renderer = r;
    this.cam = new RtsCamera(setup.canvas);
    this.cam.camera.far = 3000;
    this.cam.setBounds(setup.mapSize / 2);

    this.env = new Environment(this.scene, r);
    this.terrain = new Terrain({ mapSize: setup.mapSize, seed: setup.terrainSeed ?? 1 });
    this.scene.add(this.terrain.mesh);
    this.cam.groundHeight = (x, z) => Math.max(this.terrain.heightAt(x, z), WATER_LEVEL);
    this.water = new Water(this.terrain, this.env.sunDir, this.env.sun.color);
    this.scene.add(this.water.mesh);
    this.decals = new DecalMap(setup.mapSize * 1.3, this.quality.decalResolution);
    this.terrain.setDecals(this.decals.texture, this.decals.bounds);
    this.water.setDecals(this.decals.texture, this.decals.bounds);
    void this.terrain.loadTextures(this.quality.level === 'ultra' ? 1024 : 512);
    void this.env.loadHdri();

    this.vfx = new Vfx(
      {
        heightAt: (x, z) => this.terrain.heightAt(x, z),
        decals: this.decals,
        shake: (s, x, z) => this.shake(s, x, z),
      },
      this.env.sunDir,
      this.env.sun.color,
    );
    this.scene.add(this.vfx.group);
    this.markers = new CommandMarkers((x, z) => Math.max(this.terrain.heightAt(x, z), WATER_LEVEL));
    this.scene.add(this.markers.group);
    this.overlay.add(this.healthBars.mesh);

    for (const p of setup.players) this.teamColors.set(p.id, new THREE.Color(p.color));
    this.localPlayer = setup.localPlayer ?? setup.players.find((p) => p.kind === 'human')?.id ?? 0;
    this.fog = new FogOfWar(this.makeVisionSource(), setup.mapSize);
    this.computeAllies();
    this.post = new PostStack(r, this.scene, this.cam.camera, this.fog.texture, this.fog.bounds);

    this.setQuality(this.quality.level);
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  // --- configuration ---

  /** Low / Medium / High / Ultra: post effects, shadow resolution, LOD distances, particle density. */
  setQuality(level: QualityLevel): void {
    const q = QUALITY[level];
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    this.env.setShadowMapSize(q.shadowMapSize);
    this.vfx.setQuality(q);
    this.post.apply(q);
    this.resize();
    try {
      localStorage.setItem('frontline.quality', level);
    } catch {
      // storage blocked
    }
  }

  get qualityLevel(): QualityLevel {
    return this.quality.level;
  }

  /** Terrain height in meters, for anything that needs to sit on the ground. */
  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  setLocalPlayer(id: PlayerId): void {
    this.localPlayer = id;
    this.computeAllies();
    this.fog.setSource(this.makeVisionSource());
  }

  /** Swap in the sim's visibility once it exists. TODO(sim): wire the sim fog-of-war API here. */
  setVisibilitySource(source: VisibilitySource): void {
    this.fog.setSource(source);
  }

  /** Spectators/replays/debug: show everything. */
  setFogEnabled(on: boolean): void {
    this.fog.enabled = on;
    this.post.fog.enabled = on;
  }

  private makeVisionSource(): VisibilitySource {
    return new LocalVisionSource(128, this.setup.mapSize, this.setup.units, this.setup.players, this.localPlayer);
  }

  private computeAllies(): void {
    this.allies.clear();
    const team = this.setup.players.find((p) => p.id === this.localPlayer)?.team;
    for (const p of this.setup.players) if (p.id === this.localPlayer || (team !== undefined && p.team === team)) this.allies.add(p.id);
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.post.setSize(innerWidth, innerHeight);
    this.cam.resize(innerWidth, innerHeight);
    this.healthBars.setViewport(innerWidth, innerHeight);
  }

  // --- sim hooks ---

  /** Call right before each sim step so views can interpolate from the old pose. */
  beforeStep(sim: SimView): void {
    for (const e of sim.entities()) this.views.get(e.id)?.capturePrev(e);
  }

  handleEvents(sim: SimView, events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'spawned':
          this.ensureView(sim, ev.id);
          break;
        case 'removed': {
          const v = this.views.get(ev.id);
          if (!v) break;
          this.views.delete(ev.id);
          if (v.becomeWreck()) {
            this.onDeath(v);
            this.wrecks.push(v);
          } else v.dispose();
          break;
        }
        case 'died': {
          const v = this.views.get(ev.id);
          if (v) {
            v.die();
            this.onDeath(v);
          }
          break;
        }
        case 'fired':
          this.onFired(sim, ev.id, ev.weapon, ev.at, ev.target);
          break;
        case 'hit': {
          if (!this.fog.isVisible(ev.at.x, ev.at.z)) break;
          const v = this.views.get(ev.id);
          if (v && v.cls !== 'infantry') {
            v.root.getWorldPosition(_v);
            this.vfx.hitSparks(ev.at.x, _v.y + v.height * 0.5, ev.at.z);
          }
          break;
        }
        case 'impact':
          this.impact(ev.weapon, ev.at.x, ev.at.z);
          break;
      }
    }
  }

  private impact(weapon: string, x: number, z: number): void {
    if (!this.fog.isVisible(x, z)) return;
    const kind = weaponKind(weapon);
    if (kind === 'bullet') this.vfx.groundHit(x, z);
    else this.vfx.explosion(x, z, kind === 'bomb' ? 3 : kind === 'artillery' ? 2 : kind === 'rocket' ? 1.4 : 1.1);
  }

  private onFired(sim: SimView, id: EntityId, weapon: string, at: Vec2, target?: EntityId): void {
    const v = this.views.get(id);
    if (!v || !v.root.visible) return;
    v.playFire();
    const e = sim.get(id);
    v.muzzle(_v, _dir, e?.turretHeading);
    const kind = weaponKind(weapon, v);
    const size: MuzzleSize = kind === 'cannon' || kind === 'artillery' ? 'large' : kind === 'rocket' ? 'medium' : v.cls === 'infantry' ? 'small' : 'medium';
    this.vfx.muzzleFlash(_v, _dir, size);
    // Aim at the target's center if we can see it, else the ground point.
    const tv = target !== undefined ? this.views.get(target) : undefined;
    if (tv) tv.root.getWorldPosition(_v2).setY(_v2.y + tv.height * 0.5);
    else _v2.set(at.x, this.terrain.heightAt(at.x, at.z) + 0.5, at.z);
    if (kind === 'rocket') this.vfx.rocket(_v, _v2);
    else if (kind === 'bullet') this.vfx.tracer(_v, _v2, 420, v.cls !== 'infantry');
    else if (kind === 'cannon') this.vfx.tracer(_v, _v2, 900, true);
  }

  /** Death effects that play once per unit: blast, burning wreck smoke. */
  private onDeath(v: UnitView): void {
    if (v.deathFxDone) return;
    // Aircraft explode when they hit the ground (see updateWrecks); here they just start burning.
    const airborne = (v.cls === 'heli' || v.cls === 'jet') && !v.crashed;
    if (airborne) {
      v.root.getWorldPosition(_v);
      this.vfx.explosion(_v.x, _v.z, 0.8, _v.y);
      this.vfx.smokeColumn(_v, 0.6, 4, v.root);
      return;
    }
    v.deathFxDone = true;
    v.root.getWorldPosition(_v);
    if (!this.fog.isVisible(_v.x, _v.z) && !this.allies.has(v.owner)) return;
    if (v.cls === 'infantry') return;
    const big = v.def.armor === 'heavy' || v.cls === 'ship' ? 2.4 : 1.7;
    if (v.cls === 'ship') this.vfx.splash(_v.x, _v.z, 2);
    this.vfx.explosion(_v.x, _v.z, big, _v.y + v.height * 0.4);
    this.vfx.smokeColumn(_v, v.cls === 'ship' ? 1.3 : v.def.armor === 'heavy' ? 1 : 0.75, v.wreckLifetime, v.root);
  }

  private ensureView(sim: SimView, id: EntityId): UnitView | undefined {
    let v = this.views.get(id);
    if (v) return v;
    const e = sim.get(id);
    const def = e && this.setup.units[e.type];
    if (!e || !def) return undefined;
    v = new UnitView(id, def, e.owner, this.teamColors.get(e.owner) ?? new THREE.Color('#ffffff'), this.terrain);
    v.capturePrev(e);
    v.setSelected(this.selection.has(id));
    this.scene.add(v.root);
    this.views.set(id, v);
    if (v.cls === 'infantry' && !this.infantry.has(def.model)) {
      const inst = new InfantryInstancer(def.model);
      this.infantry.set(def.model, inst);
      this.scene.add(inst.group);
    }
    return v;
  }

  setSelection(ids: Iterable<EntityId>): void {
    this.selection = new Set(ids);
    for (const [id, v] of this.views) v.setSelected(this.selection.has(id));
  }

  /**
   * Show feedback for a command the local player just issued (move/attack-move rings, attack brackets,
   * rally lines). TODO(ui): call this from the input controller right after submitting a command.
   */
  markCommand(cmd: Command): void {
    switch (cmd.type) {
      case 'move':
        this.markers.ground(cmd.target.x, cmd.target.z, cmd.attackMove ? 'attackMove' : 'move');
        break;
      case 'attack': {
        const tv = this.views.get(cmd.targetId);
        if (tv) this.markers.target(() => (this.views.has(cmd.targetId) ? tv.root.position : null), tv.def.radius);
        break;
      }
      case 'build':
        this.markers.ground(cmd.at.x, cmd.at.z, 'build');
        break;
      case 'setRally':
        this.rallies.set(cmd.factory, { ...cmd.at });
        this.markers.ground(cmd.at.x, cmd.at.z, 'move');
        break;
    }
  }

  private shake(strength: number, x: number, z: number): void {
    const d = Math.hypot(x - this.cam.target.x, z - this.cam.target.z);
    const falloff = THREE.MathUtils.clamp(1 - d / (60 + this.cam.viewDistance * 0.6), 0, 1);
    const zoom = 1.2 - this.cam.zoom * 0.7;
    this.cam.addTrauma(strength * falloff * zoom);
  }

  /** Debug: drop a burning wreck of `type` at (x, z) with no sim entity behind it. */
  debugWreck(type: string, owner: PlayerId, x: number, z: number, heading = 0): void {
    const def = this.setup.units[type];
    if (!def) return;
    const id = -1 - this.wrecks.length;
    const v = new UnitView(id, def, owner, this.teamColors.get(owner) ?? new THREE.Color('#ffffff'), this.terrain);
    const e = { id, kind: 'unit', type, owner, pos: { x, z }, heading, hp: 0, maxHp: def.hp, moving: false } as const;
    v.capturePrev(e);
    v.update(e, 1, 0, false);
    v.becomeWreck();
    this.scene.add(v.root);
    this.onDeath(v);
    this.wrecks.push(v);
  }

  // --- per frame ---

  /** Render one frame. `alpha` is how far we are between the last two sim ticks. */
  frame(sim: SimView, alpha: number, dt: number): void {
    this.time += dt;
    this.frameNo++;
    this.cam.update(dt);
    const camera = this.cam.camera;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.fog.update(sim, dt);

    this.updateUnits(sim, alpha, dt);
    this.updateWrecks(dt);
    this.updateOverlays(dt);

    this.env.updateShadows(this.cam.target, this.cam.viewDistance);
    this.water.update(this.time);
    this.vfx.update(dt);
    this.decals.update(this.renderer, dt);

    this.post.render(dt, this.cam.zoom);
    this.renderer.autoClear = false;
    this.renderer.render(this.overlay, camera);
    this.renderer.autoClear = true;
  }

  /** Whether a rig should advance its animation this frame (near: always; far/off-screen: throttled). */
  private animateThisFrame(v: UnitView, camPos: THREE.Vector3): boolean {
    _v.copy(v.root.position);
    if (!_frustum.containsPoint(_v.setY(_v.y + 1))) return (this.frameNo + v.id) % 8 === 0;
    const d = camPos.distanceTo(v.root.position);
    if (d < 150) return true;
    return (this.frameNo + v.id) % (d < 300 ? 2 : 4) === 0;
  }

  private updateUnits(sim: SimView, alpha: number, dt: number): void {
    const camPos = this.cam.camera.position;
    const q = this.quality;
    const rigCandidates: { v: UnitView; d: number }[] = [];
    for (const e of sim.entities()) {
      const v = this.ensureView(sim, e.id);
      if (!v) continue;
      const visible = this.allies.has(e.owner) || this.fog.isVisible(e.pos.x, e.pos.z) || v.dying;
      v.root.visible = visible;
      v.update(e, alpha, dt, visible && this.animateThisFrame(v, camPos));
      if (!visible) continue;
      if (v.cls === 'infantry') {
        rigCandidates.push({ v, d: v.dying ? -1 : camPos.distanceTo(v.root.position) });
      } else if (e.moving && !v.dying) {
        this.groundEffects(v, dt);
      }
    }

    // Infantry LOD: nearest N within range get the animated rig; the rest are instanced poses.
    rigCandidates.sort((a, b) => a.d - b.d);
    for (const inst of this.infantry.values()) inst.begin();
    rigCandidates.forEach(({ v, d }, i) => {
      const inst = this.infantry.get(v.def.model);
      const rig = !inst?.ready || d < 0 || (d < q.infantryLodDistance && i < q.maxInfantryRigs);
      v.setRigVisible(rig);
      if (!rig) inst!.add(v, this.time);
    });
    for (const inst of this.infantry.values()) inst.end();
  }

  /** Tracks, dust and wakes behind moving units. */
  private groundEffects(v: UnitView, dt: number): void {
    const p = v.root.position;
    const yaw = v.root.rotation.y;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const r = v.def.radius;
    if (v.speed < 1) return;
    v.trackAcc += v.speed * dt;
    if (v.cls === 'vehicle') {
      const tracked = !!v.def.turretNode || v.def.armor === 'heavy';
      if (v.trackAcc > 1.1) {
        v.trackAcc = 0;
        if (!this.terrain.isWater(p.x, p.z)) {
          this.decals.stamp(tracked ? DecalKind.Tracks : DecalKind.Wheels, p.x - fx * r * 0.4, p.z - fz * r * 0.4, 1.6, r * 1.25, yaw, tracked ? 0.85 : 0.55);
        }
      }
      if (this.quality.dustTrails && v.speed > 1.5) this.vfx.dust(p.x - fx * r, p.z - fz * r, v.speed, r * 0.6, dt);
    } else if (v.cls === 'ship') {
      if (v.trackAcc > 2) {
        v.trackAcc = 0;
        this.decals.stamp(DecalKind.Wake, p.x - fx * r * 0.8, p.z - fz * r * 0.8, r * 2.2, r * 1.2 + v.speed * 0.15, yaw, 1);
      }
      this.vfx.spray(p.x + fx * r, p.z + fz * r, v.speed, dt);
    } else if (v.cls === 'heli' && v.speed >= 0) {
      // Rotor wash over water/dust when low; cruise altitude keeps this subtle.
      if (this.terrain.isWater(p.x, p.z)) this.vfx.spray(p.x, p.z, 2, dt);
    }
  }

  private updateWrecks(dt: number): void {
    const camPos = this.cam.camera.position;
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.updateWreck(dt, this.animateThisFrame(w, camPos));
      if (!w.deathFxDone && w.crashed) this.onDeath(w);
      if (w.wreckDone) {
        w.dispose();
        this.wrecks.splice(i, 1);
      }
    }
  }

  private updateOverlays(dt: number): void {
    this.healthBars.begin();
    for (const v of this.views.values()) {
      if (!v.root.visible || !v.isAlive || v.maxHp <= 0) continue;
      const sel = this.selection.has(v.id);
      if (!sel && v.hp >= v.maxHp) continue;
      _v.copy(v.root.position);
      _v.y += v.height + (v.cls === 'infantry' ? 0.5 : 1.2);
      if (!_frustum.containsPoint(_v)) continue;
      const w = v.cls === 'infantry' ? 22 : THREE.MathUtils.clamp(v.def.radius * 11, 30, 60);
      this.healthBars.add(_v, v.hp / v.maxHp, w, sel);
    }
    this.healthBars.end();

    // Rally lines for selected factories.
    const shown = new Set<number>();
    for (const id of this.selection) {
      const at = this.rallies.get(id);
      const v = this.views.get(id);
      if (!at || !v) continue;
      shown.add(id);
      this.markers.rally(id, v.root.position, _v2.set(at.x, this.terrain.heightAt(at.x, at.z), at.z));
    }
    this.markers.hideRallies(shown);
    this.markers.update(dt, this.time);
  }

  // --- Picker ---

  private ndc(sx: number, sy: number): THREE.Vector2 {
    return new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  }

  pickGround(sx: number, sy: number): Vec2 | null {
    this.raycaster.setFromCamera(this.ndc(sx, sy), this.cam.camera);
    const hit = this.terrain.raycast(this.raycaster.ray);
    if (!hit) return null;
    // Clicking open water picks the water surface, not the sea floor.
    if (hit.y < WATER_LEVEL) {
      const r = this.raycaster.ray;
      if (r.direction.y < 0) {
        const t = (r.origin.y - WATER_LEVEL) / -r.direction.y;
        return { x: r.origin.x + r.direction.x * t, z: r.origin.z + r.direction.z * t };
      }
    }
    return { x: hit.x, z: hit.z };
  }

  private pickable(): UnitView[] {
    const out: UnitView[] = [];
    for (const v of this.views.values()) if (v.root.visible && v.isAlive) out.push(v);
    return out;
  }

  pickEntity(sx: number, sy: number): EntityId | null {
    this.raycaster.setFromCamera(this.ndc(sx, sy), this.cam.camera);
    const candidates = this.pickable();
    const roots = candidates.filter((v) => v.cls !== 'infantry').map((v) => v.root);
    for (const hit of this.raycaster.intersectObjects(roots, true)) {
      const id = hit.object.userData.entityId;
      if (typeof id === 'number' && hit.object.visible) return id;
    }
    // Screen-space fallback: nearest unit center within its projected radius (+ a few px of slack).
    const cam = this.cam.camera;
    const pxPerUnitAt1 = innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    let best: EntityId | null = null;
    let bestD = Infinity;
    for (const v of candidates) {
      _v.copy(v.root.position);
      _v.y += v.height * 0.5;
      const dist = _v.distanceTo(cam.position);
      _v.project(cam);
      if (_v.z > 1) continue;
      const px = ((_v.x + 1) / 2) * innerWidth;
      const py = ((1 - _v.y) / 2) * innerHeight;
      const d = Math.hypot(px - sx, py - sy);
      const radius = (v.def.radius * v.scale * pxPerUnitAt1) / dist + 6;
      if (d < radius && d < bestD) {
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
    for (const v of this.pickable()) {
      _v.copy(v.root.position);
      _v.y += v.height * 0.4;
      _v.project(this.cam.camera);
      const sx = ((_v.x + 1) / 2) * innerWidth;
      const sy = ((1 - _v.y) / 2) * innerHeight;
      if (_v.z < 1 && sx >= lx && sx <= hx && sy >= ly && sy <= hy) out.push(v.id);
    }
    return out;
  }
}
