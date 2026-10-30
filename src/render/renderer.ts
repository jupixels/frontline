import * as THREE from 'three';
import type { Command } from '../shared/commands';
import structuresJson from '../../data/structures.json';
import weaponsJson from '../../data/weapons.json';
import type { MapDef, UnitDef } from '../shared/data';
import { TerrainModel } from '../shared/terrain';
import type { SimView, SimViewExt } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import { TICK_SECONDS, type EntityId, type PlayerId, type PlayerSlot, type Vec2 } from '../shared/types';
import type { Picker } from '../shared/view';
import { RtsCamera } from './camera';
import { DecalKind, DecalMap } from './decals';
import { atmosphereFor, Environment } from './environment';
import { Scenery } from './scenery';
import { MISSILE_ARC, TacticalLayer } from './tactical';
import { FogOfWar, LocalVisionSource, SimFogSource, type VisibilitySource } from './fog';
import { CommandMarkers, HealthBars } from './overlay';
import { PostStack } from './post';
import { LodInstancer } from './lod';
import { gpuName, initialQuality, QUALITY, type QualityLevel, type QualitySettings } from './quality';
import { CapturePointView } from './points';
import { PathLines, type PathLineMode } from './paths';
import { Terrain, WATER_LEVEL } from './terrain';
import { UnitView, type ViewDef } from './units';
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
  /** Structure models and footprints, keyed like data/structures.json. Defaults to that file. */
  structures?: Record<string, RenderStructureDef>;
  /** The map: terrain, water, forests, bridges, props and atmosphere, exactly as the sim plays it. */
  map?: MapDef;
}

/** What the renderer needs per structure type (a subset of data/structures.json entries). */
export interface RenderStructureDef {
  model: string;
  /** Width (x) and depth (z) in meters. */
  footprint: [number, number];
  hp?: number;
}

type WeaponKind = 'bullet' | 'cannon' | 'rocket' | 'artillery' | 'bomb' | 'torpedo';

interface WeaponJson {
  delivery?: 'hitscan' | 'projectile' | 'indirect';
  damageType?: string;
  splash?: number;
}
const WEAPONS = weaponsJson as unknown as Record<string, WeaponJson>;

/** Effect family for a weapon: from data/weapons.json when it's there, else from its name. */
function weaponKind(weapon: string, shooter?: UnitView): WeaponKind {
  const w = weapon.toLowerCase();
  const def = WEAPONS[weapon];
  if (def) {
    if (def.damageType === 'torpedo') return 'torpedo';
    if (/bomb/.test(w)) return 'bomb';
    if (def.delivery === 'indirect') return /mlrs|rocket/.test(w) ? 'rocket' : 'artillery';
    if (def.delivery === 'projectile') return /rocket|missile|atgm|sam|rpg/.test(w) ? 'rocket' : 'cannon';
    return def.damageType === 'small_arms' || /autocannon|aa_gun|boat_gun|jet_cannon|heli_gun/.test(w) ? 'bullet' : 'cannon';
  }
  if (/rocket|missile|atgm|rpg|sam|aam|hellfire|javelin|tow/.test(w)) return 'rocket';
  if (/mortar|artillery|howitzer|arty/.test(w)) return 'artillery';
  if (/bomb/.test(w)) return 'bomb';
  if (/cannon|shell|apfsds|heat|main|tank|autocannon/.test(w)) return 'cannon';
  if (/rifle|mg|machine|bullet|smg|pistol|minigun/.test(w)) return 'bullet';
  return shooter?.def.turretNode ? 'cannon' : 'bullet';
}

/** Explosion size for an impact: from the weapon's splash radius when known. */
function impactSize(weapon: string, kind: WeaponKind): number {
  const splash = WEAPONS[weapon]?.splash;
  if (splash) return THREE.MathUtils.clamp(splash / 5, 0.7, 3.5);
  return kind === 'bomb' ? 3 : kind === 'artillery' ? 2 : kind === 'rocket' ? 1.4 : 1.1;
}

function simExt(sim: SimView): SimViewExt | null {
  const s = sim as Partial<SimViewExt>;
  return typeof s.buildProgress === 'function' && s.fog ? (sim as unknown as SimViewExt) : null;
}

const _v = new THREE.Vector3();
const NEUTRAL_EDGE = new THREE.Color('#d8d8d0');
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
  readonly scenery: Scenery;
  private readonly tactical: TacticalLayer;
  private readonly post: PostStack;
  private readonly overlay = new THREE.Scene();
  private readonly healthBars = new HealthBars();
  private readonly markers: CommandMarkers;
  private readonly views = new Map<EntityId, UnitView>();
  private readonly points = new Map<EntityId, CapturePointView>();
  private readonly structureDefs: Record<string, RenderStructureDef>;
  private simFogAttached = false;
  private ext: SimViewExt | null = null;
  private readonly paths: PathLines;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private readonly wrecks: UnitView[] = [];
  /** Far-LOD instancers per unit type. */
  private readonly lods = new Map<string, LodInstancer>();
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
    this.quality = QUALITY[initialQuality(gpuName(r.getContext()))];
    this.cam = new RtsCamera(setup.canvas);
    this.cam.camera.far = 3000;
    this.cam.setBounds(setup.mapSize / 2);

    const atmosphere = atmosphereFor(setup.map?.atmosphere);
    this.env = new Environment(this.scene, r, atmosphere);
    this.structureDefs = setup.structures ?? (structuresJson as unknown as Record<string, RenderStructureDef>);
    const model = new TerrainModel(setup.map ?? { size: setup.mapSize });
    this.terrain = new Terrain({ model });
    this.scene.add(this.terrain.mesh);
    this.cam.groundHeight = (x, z) => Math.max(this.terrain.heightAt(x, z), WATER_LEVEL);
    this.water = new Water(this.terrain, this.env.sunDir, this.env.sun.color);
    if (atmosphere.water) {
      (this.water.uniforms.uShallow.value as THREE.Color).set(atmosphere.water[0]);
      (this.water.uniforms.uDeep.value as THREE.Color).set(atmosphere.water[1]);
    }
    this.scene.add(this.water.mesh);
    this.quality = QUALITY[initialQuality(gpuName(r.getContext()))];
    this.scenery = new Scenery(setup.map ?? { id: '', name: '', size: setup.mapSize, spawns: [] }, model, (x, z) => this.terrain.heightAt(x, z), this.quality.level !== 'low');
    this.scene.add(this.scenery.group);
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
    this.paths = new PathLines((x, z) => Math.max(this.terrain.heightAt(x, z), WATER_LEVEL));
    this.scene.add(this.paths.mesh);
    this.overlay.add(this.healthBars.mesh);

    for (const p of setup.players) this.teamColors.set(p.id, new THREE.Color(p.color));
    this.tactical = new TacticalLayer((x, z) => Math.max(this.terrain.heightAt(x, z), WATER_LEVEL), (o) => this.teamColors.get(o) ?? new THREE.Color('#ffffff'));
    this.overlay.add(this.tactical.group);
    this.localPlayer = setup.localPlayer ?? setup.players.find((p) => p.kind === 'human')?.id ?? 0;
    this.fog = new FogOfWar(this.makeVisionSource());
    if (this.localPlayer < 0) this.fog.enabled = false;
    this.computeAllies();
    this.post = new PostStack(r, this.scene, this.cam.camera, this.fog.texture, this.fog.bounds);

    this.post.fog.enabled = this.fog.enabled;
    this.setQuality(this.quality.level);
    this.listen(window, 'resize', () => this.resize());
    this.resize();
  }

  private listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  /**
   * Tear down: window/DOM listeners (renderer and camera), every GPU resource of this renderer, and
   * the WebGL context. Model/material caches stay in memory (CPU side) for the next match.
   */
  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.cam.dispose();
    for (const v of this.views.values()) this.scene.add(v.root);
    for (const w of this.wrecks) this.scene.add(w.root);
    const textures = new Set<THREE.Texture>();
    const collect = (m: THREE.Material) => {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      const u = (m as THREE.ShaderMaterial).uniforms;
      if (u) for (const { value } of Object.values(u)) if (value instanceof THREE.Texture) textures.add(value);
      m.dispose();
    };
    for (const scene of [this.scene, this.overlay]) {
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach(collect);
        else if (mat) collect(mat);
      });
    }
    for (const u of Object.values(this.terrain.uniforms)) if (u.value instanceof THREE.Texture) textures.add(u.value);
    textures.add(this.fog.texture);
    if (this.scene.environment) textures.add(this.scene.environment);
    for (const t of textures) t.dispose();
    for (const v of this.views.values()) v.dispose();
    for (const w of this.wrecks) w.dispose();
    for (const p of this.points.values()) p.dispose();
    this.views.clear();
    this.wrecks.length = 0;
    this.points.clear();
    this.decals.dispose();
    this.scenery.dispose();
    this.tactical.dispose();
    this.vfx.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // --- configuration ---

  /** Low / Medium / High / Ultra: post effects, shadow resolution, LOD distances, particle density. */
  setQuality(level: QualityLevel): void {
    const q = QUALITY[level];
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    this.env.setShadowMapSize(q.shadowMapSize);
    this.scenery?.setShadows(level === 'high' || level === 'ultra');
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
    this.simFogAttached = false;
    this.setFogEnabled(id >= 0);
  }

  /** Override where fog of war comes from (the sim's fog is picked up automatically). */
  setVisibilitySource(source: VisibilitySource): void {
    this.fog.setSource(source);
    this.simFogAttached = true;
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
        case 'incoming':
          // Shown to everyone (the sim reveals it so targets can dodge).
          this.markers.incoming(ev.at.x, ev.at.z, ev.radius, Math.max(0.5, (ev.arrive - (sim.gameTick ?? sim.tick)) * TICK_SECONDS));
          break;
        case 'smoke':
          this.vfx.smokeScreen(ev.at.x, ev.at.z, ev.radius, Math.max(1, (ev.until - (sim.gameTick ?? sim.tick)) * TICK_SECONDS));
          break;
        case 'superweaponLaunched': {
          // Early warning for everyone: a big marker with a countdown, and the missile itself.
          const secs = Math.max(1, (ev.arrive - (sim.gameTick ?? sim.tick)) * TICK_SECONDS);
          this.markers.incoming(ev.at.x, ev.at.z, ev.radius, secs);
          const site = sim.get(ev.site);
          const from = site ? new THREE.Vector3(site.pos.x, this.terrain.heightAt(site.pos.x, site.pos.z) + 14, site.pos.z) : new THREE.Vector3(ev.at.x, 200, ev.at.z + 900);
          const to = new THREE.Vector3(ev.at.x, this.terrain.heightAt(ev.at.x, ev.at.z), ev.at.z);
          this.tactical.launch(from, to, secs, this.time);
          this.vfx.rocket(from, to, from.distanceTo(to) / secs, MISSILE_ARC);
          break;
        }
        case 'superweaponImpact': {
          const { x, z } = ev.at;
          this.vfx.explosion(x, z, 3.5);
          for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2;
            const r = ev.radius * (0.35 + Math.random() * 0.45);
            this.vfx.explosion(x + Math.cos(a) * r, z + Math.sin(a) * r, 2 + Math.random());
          }
          this.vfx.smokeColumn(new THREE.Vector3(x, this.terrain.heightAt(x, z), z), 2.5, 60);
          this.shake(2.5, x, z);
          break;
        }
        case 'placed':
        case 'built':
          this.ensureView(sim, ev.id);
          break;
      }
    }
  }

  private impact(weapon: string, x: number, z: number): void {
    if (!this.fog.isVisible(x, z)) return;
    const kind = weaponKind(weapon);
    if (kind === 'bullet') this.vfx.groundHit(x, z);
    else if (kind === 'torpedo') this.vfx.splash(x, z, 2.2);
    else this.vfx.explosion(x, z, impactSize(weapon, kind));
  }

  private onFired(sim: SimView, id: EntityId, weapon: string, at: Vec2, target?: EntityId): void {
    // Garrisons fire out of their building.
    const inside = sim.get(id)?.inside;
    const v = this.views.get(inside || id);
    if (!v || !v.root.visible) return;
    v.playFire();
    const e = sim.get(id);
    v.muzzle(_v, _dir, e?.turretHeading);
    const kind = weaponKind(weapon, v);
    if (kind === 'bomb' || kind === 'torpedo') return;
    const size: MuzzleSize = kind === 'cannon' || kind === 'artillery' ? 'large' : kind === 'rocket' ? 'medium' : v.cls === 'infantry' ? 'small' : 'medium';
    this.vfx.muzzleFlash(_v, _dir, size);
    // Aim at the target's center if we can see it, else the ground point.
    const tv = target !== undefined ? this.views.get(target) : undefined;
    if (tv) tv.root.getWorldPosition(_v2).setY(_v2.y + tv.height * 0.5);
    else _v2.set(at.x, this.terrain.heightAt(at.x, at.z) + 0.5, at.z);
    if (kind === 'rocket') this.vfx.rocket(_v, _v2, WEAPONS[weapon]?.delivery === 'indirect' ? 70 : 110, WEAPONS[weapon]?.delivery === 'indirect' ? 0.35 : 0.06);
    else if (kind === 'artillery') this.vfx.shell(_v, _v2);
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
    if (v.cls === 'structure') {
      const [w, d] = v.def.footprint ?? [10, 10];
      for (let i = 0; i < 3; i++) this.vfx.explosion(_v.x + (Math.random() - 0.5) * w * 0.6, _v.z + (Math.random() - 0.5) * d * 0.6, 2.2);
      this.vfx.smokeColumn(_v, 1.8, v.wreckLifetime, v.root);
      return;
    }
    const big = v.def.armor === 'heavy' || v.cls === 'ship' ? 2.4 : 1.7;
    if (v.cls === 'ship') this.vfx.splash(_v.x, _v.z, 2);
    this.vfx.explosion(_v.x, _v.z, big, _v.y + v.height * 0.4);
    this.vfx.smokeColumn(_v, v.cls === 'ship' ? 1.3 : v.def.armor === 'heavy' ? 1 : 0.75, v.wreckLifetime, v.root);
  }

  private ensureView(sim: SimView, id: EntityId): UnitView | undefined {
    let v = this.views.get(id);
    if (v) return v;
    const e = sim.get(id);
    if (!e) return undefined;
    if (e.kind === 'point') {
      this.ensurePoint(id);
      return undefined;
    }
    const def = e.kind === 'structure' ? this.structureViewDef(e.type) : this.setup.units[e.type];
    if (!def) return undefined;
    v = new UnitView(id, def, e.owner, this.teamColors.get(e.owner) ?? new THREE.Color('#ffffff'), this.terrain);
    v.capturePrev(e);
    v.setSelected(this.selection.has(id));
    this.scene.add(v.root);
    this.views.set(id, v);
    if ((v.cls === 'infantry' || v.cls === 'vehicle') && !this.lods.has(e.type)) {
      const lod = new LodInstancer(def, v.cls);
      this.lods.set(e.type, lod);
      this.scene.add(lod.group);
    }
    return v;
  }

  private readonly structureViewCache = new Map<string, ViewDef>();

  /** A structure as the unit view sees it: armor 'structure', radius from the footprint. */
  private structureViewDef(type: string): ViewDef | undefined {
    let d = this.structureViewCache.get(type);
    if (d) return d;
    const s = this.structureDefs[type];
    if (!s) return undefined;
    const [w, dep] = s.footprint;
    d = {
      name: type, model: s.model, domain: 'ground', armor: 'structure', hp: s.hp ?? 1000, speed: 0, turnRate: 0,
      radius: Math.max(w, dep) * 0.55, sight: 0, cost: 0, buildSeconds: 0, footprint: [w, dep],
    };
    this.structureViewCache.set(type, d);
    return d;
  }

  private ensurePoint(id: EntityId): CapturePointView {
    let p = this.points.get(id);
    if (!p) {
      p = new CapturePointView(id, (x, z) => Math.max(this.terrain.heightAt(x, z), WATER_LEVEL));
      this.points.set(id, p);
      this.scene.add(p.root);
    }
    return p;
  }

  /** Path lines for the selection only (default), or for every own unit with orders. */
  setPathLines(mode: PathLineMode): void {
    this.paths.mode = mode;
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
    if ('units' in cmd) this.paths.flash(cmd.units, this.time, 'queue' in cmd && !!cmd.queue);
    else if (cmd.type === 'build') this.paths.flash([cmd.builder], this.time);
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
    const def = this.setup.units[type] ?? this.structureViewDef(type);
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
    this.attachSimFog(sim);
    this.fog.update(sim, dt);

    this.updateUnits(sim, alpha, dt);
    this.updateTactical(sim);
    this.updatePoints(sim);
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

  /** Rank chevrons, garrison counts, frontline ribbons and missiles. */
  private updateTactical(sim: SimView): void {
    const t = this.tactical;
    t.begin();
    for (const e of sim.entities()) {
      const v = this.views.get(e.id);
      if (!v || !v.root.visible || !v.isAlive) continue;
      const rank = e.rank ?? 0;
      // Garrisons and loaded transports show how many are inside (own and allied only for transports).
      const garrison = e.kind === 'structure' || this.allies.has(e.owner) ? (e.cargo?.length ?? 0) : 0;
      if (!rank && !garrison) continue;
      _v.copy(v.root.position);
      _v.y += v.height + (v.cls === 'infantry' ? 1.6 : v.cls === 'structure' ? 4 : 3);
      if (!_frustum.containsPoint(_v)) continue;
      if (garrison) t.badge(e.id, `g${garrison}`, _v, 4.5);
      else t.badge(e.id, `r${rank}`, _v, v.cls === 'infantry' ? 1.3 : 2.4);
    }
    t.end();
    if (this.ext && this.frameNo % 10 === 0) t.setLines(this.localPlayer >= 0 ? this.ext.lines(this.localPlayer) : []);
    t.update(this.time);
  }

  /** Use the sim's own fog of war once we see a sim that has one. */
  private attachSimFog(sim: SimView): void {
    if (this.simFogAttached) return;
    this.simFogAttached = true;
    this.ext = simExt(sim);
    if (this.ext && this.localPlayer >= 0) this.fog.setSource(new SimFogSource(this.ext.fog, this.localPlayer, this.setup.mapSize));
  }

  /** Whether `e` should be drawn for the local player right now. */
  private canSee(id: EntityId, owner: PlayerId, x: number, z: number): boolean {
    if (!this.fog.enabled || this.allies.has(owner)) return true;
    return this.ext ? this.ext.fog.canSee(this.localPlayer, id) : this.fog.isVisible(x, z);
  }

  private updatePoints(sim: SimView): void {
    for (const [id, p] of this.points) {
      const e = sim.get(id);
      if (!e) {
        p.dispose();
        this.points.delete(id);
        continue;
      }
      const cap = this.ext?.capture(id);
      const owner = cap ? cap.owner : e.owner;
      const color = (pl: PlayerId | undefined) => (pl !== undefined && pl >= 0 ? this.teamColors.get(pl) ?? null : null);
      // Points are map knowledge: always drawn, like on the minimap.
      p.update(e.pos.x, e.pos.z, cap?.radius ?? 15, color(owner), color(cap?.capturer), cap?.progress ?? 0, this.time);
    }
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
    const soldiers: { v: UnitView; d: number; type: string }[] = [];
    const vehicles: { v: UnitView; d: number; type: string }[] = [];
    for (const e of sim.entities()) {
      const v = this.ensureView(sim, e.id);
      if (!v) continue;
      // Passengers and garrisons are hidden inside their transport or building.
      let visible = !e.inside && (v.dying || this.canSee(e.id, e.owner, e.pos.x, e.pos.z));
      if (v.cls === 'structure') {
        // Buildings stay on the map (as last seen) once discovered.
        if (visible) v.seenOnce = true;
        else visible = v.seenOnce && this.fog.isExplored(e.pos.x, e.pos.z);
        v.build = this.ext ? this.ext.buildProgress(e.id) : 1;
        v.setEdgeColor(this.teamColors.get(e.owner) ?? NEUTRAL_EDGE);
      }
      v.root.visible = visible;
      const d = camPos.distanceTo(v.root.position);
      // LOD'd units skip their mixer; it catches up (accumulated dt) when they come back to full detail.
      v.update(e, alpha, dt, visible && v.rigVisible && this.animateThisFrame(v, camPos));
      if (!visible) continue;
      if (v.cls === 'infantry') soldiers.push({ v, d: v.dying ? -1 : d, type: e.type });
      else if (v.cls === 'vehicle') vehicles.push({ v, d: v.dying ? -1 : d, type: e.type });
      if (e.moving && !v.dying && v.cls !== 'infantry') this.groundEffects(v, dt);
    }

    // LOD: the nearest N units within range keep their full animated model; the rest are drawn by
    // the per-type instancers.
    for (const lod of this.lods.values()) lod.begin();
    this.assignLod(soldiers, q.infantryLodDistance, q.maxInfantryRigs);
    this.assignLod(vehicles, q.vehicleLodDistance, q.maxVehicleRigs);
    for (const lod of this.lods.values()) lod.end();
  }

  private assignLod(list: { v: UnitView; d: number; type: string }[], range: number, cap: number): void {
    list.sort((a, b) => a.d - b.d);
    list.forEach(({ v, d, type }, i) => {
      const lod = this.lods.get(type);
      const full = !lod?.ready || d < 0 || (d < range && i < cap);
      v.setRigVisible(full);
      if (!full) lod!.add(v, this.time);
    });
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
      const building = v.cls === 'structure' && v.build < 1;
      if (!sel && v.hp >= v.maxHp && !building) continue;
      _v.copy(v.root.position);
      _v.y += v.height + (v.cls === 'infantry' ? 0.5 : 1.2);
      if (!_frustum.containsPoint(_v)) continue;
      const w = v.cls === 'infantry' ? 22 : THREE.MathUtils.clamp(v.def.radius * 11, 30, v.cls === 'structure' ? 80 : 60);
      // Build progress (blue) sits just under the health bar.
      if (building) this.healthBars.add(_v, v.build, w, sel, true);
      if (sel || v.hp < v.maxHp) this.healthBars.add(building ? _v.setY(_v.y + 2) : _v, v.hp / v.maxHp, w, sel);
    }
    this.healthBars.end();

    // Rally lines for selected factories.
    const shown = new Set<number>();
    for (const id of this.selection) {
      const at = this.ext?.rally(id) ?? this.rallies.get(id);
      const v = this.views.get(id);
      if (!at || !v) continue;
      shown.add(id);
      this.markers.rally(id, v.root.position, _v2.set(at.x, this.terrain.heightAt(at.x, at.z), at.z));
    }
    this.markers.hideRallies(shown);
    this.markers.update(dt, this.time);

    const width = THREE.MathUtils.clamp(this.cam.viewDistance * 0.006, 0.4, 2.6);
    this.paths.update(
      this.ext,
      this.localPlayer,
      this.selection,
      () => this.views.keys(),
      (id) => {
        const v = this.views.get(id);
        return v && v.isAlive && v.cls !== 'structure' ? v.root.position : null;
      },
      this.time,
      width,
    );
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
