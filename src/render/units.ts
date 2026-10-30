import * as THREE from 'three';
import { SUPPRESS_PINNED } from '../shared/entities';
import type { UnitDef } from '../shared/data';
import type { EntityState } from '../shared/entities';
import { materialRole, TEAM_ACCENT, TEAM_PAINT, teamMaterial } from './materials';
import { cloneModel, loadModel, type PreparedModel } from './models';
import { WATER_LEVEL } from './terrain';

/** Look-alike models a unit type picks from per entity, for squad variety (the far LOD uses the first). */
const VARIANTS: Record<string, string[]> = {
  'models/rifleman.glb': ['models/rifleman.glb', 'models/rifleman_b.glb', 'models/rifleman_c.glb'],
};

/** Infantry are drawn larger than life so they read at RTS zoom. */
export const INFANTRY_SCALE = 3.2;
/** Extra width and depth on top of that, so soldiers read as sturdier figures. */
export const INFANTRY_GIRTH = 1.2;

/** Clip-name candidates per animation state, first match wins (vehicles vs soldiers differ). */
const CLIPS = {
  idle: ['Idle', 'MilitaryIdle01', 'Idle01', 'Idle_Rotors'],
  move: ['Move', 'Run01_Forward', 'Walk01_Forward', 'Fly'],
  fire: ['Fire', 'AssaultRifle_Aim01_Shoot01', 'Shoot'],
  death: ['Death', 'Death01', 'Death02', 'Crash', 'Sink'],
};
type AnimState = 'idle' | 'move';

export type UnitClass = 'infantry' | 'vehicle' | 'heli' | 'jet' | 'ship' | 'structure';

/** A structure seen through the unit view: footprint in meters (x, z). */
export type ViewDef = UnitDef & { footprint?: [number, number] };

export function unitClass(def: UnitDef): UnitClass {
  if (def.armor === 'structure') return 'structure';
  if (def.domain === 'naval') return 'ship';
  if (def.domain === 'air') return def.speed > 35 ? 'jet' : 'heli';
  if (def.armor === 'infantry') return 'infantry';
  return 'vehicle';
}

/** What the view needs from the world around it. */
export interface UnitHost {
  heightAt(x: number, z: number): number;
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Stable 0..1 values per entity id, so each soldier keeps its own quirks. */
function idRandom(id: number, k: number): number {
  let h = Math.imul(id ^ Math.imul(k, 0x9e3779b1), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * See-through silhouette for own units hidden behind buildings, trees or hills: the same mesh again,
 * drawn only where something else is in front of it (depth test inverted), as a soft team-colored
 * rim. Works for skinned rigs and for the far-LOD instancers (instance color carries the team).
 */
export function xrayMaterial(color?: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color ?? new THREE.Color(1, 1, 1) } },
    vertexShader: XRAY_VERT,
    fragmentShader: XRAY_FRAG,
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
  });
}

const xrayCache = new Map<number, THREE.ShaderMaterial>();
function xrayFor(color: THREE.Color): THREE.ShaderMaterial {
  const key = color.getHex();
  let m = xrayCache.get(key);
  if (!m) xrayCache.set(key, (m = xrayMaterial(color.clone())));
  return m;
}

const XRAY_VERT = /* glsl */ `
#define XRAY_PULL 4.0
#include <common>
#include <skinning_pars_vertex>
uniform vec3 uColor;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vTint;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  // Slid a few meters toward the camera along the view ray: the unit's own inner layers and the
  // ground at its feet then never count as occluders, only a building, tree or hill in front does.
  mvPosition.xyz *= max(0.0, 1.0 - XRAY_PULL / length(mvPosition.xyz));
  gl_Position = projectionMatrix * mvPosition;
  vNormalV = normalize(transformedNormal);
  vViewV = -mvPosition.xyz;
  vTint = uColor;
  #ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
  #endif
}
`;

const XRAY_FRAG = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vTint;
void main() {
  float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
  float rim = pow(1.0 - facing, 1.6);
  vec3 c = mix(vTint, vec3(1.0), 0.18) * 1.5;
  gl_FragColor = vec4(c, 0.14 + 0.66 * rim);
}
`;

/**
 * The visual for one sim entity: model clone with team materials, animation mixer, terrain/air/sea
 * motion, selection ring, and a death → wreck lifecycle that outlives the sim entity.
 */
export class UnitView {
  /** Positioned at the unit's ground point (or altitude), yawed to its heading. */
  readonly root = new THREE.Group();
  /** Pitch/roll/bank and scale live here so `root` stays a clean yaw-only frame. */
  readonly body = new THREE.Group();
  readonly cls: UnitClass;
  readonly scale: number;
  private model?: THREE.Object3D;
  private prepared?: PreparedModel;
  private mixer?: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private state?: AnimState;
  private turret?: THREE.Object3D;
  private turretBase?: THREE.Quaternion;
  /** Drawn turret heading (world), eased toward the sim's so traverses start and stop smoothly. */
  private turretShown?: number;
  private turretVel = 0;
  /** Team color for the see-through silhouette (own units only), and the silhouette meshes. */
  private xrayColor: THREE.Color | null = null;
  private readonly xrayMeshes: THREE.Mesh[] = [];
  private readonly ring: THREE.Mesh;
  private readonly meshes: THREE.Mesh[] = [];
  /** Model-space height (meters, after scale) once loaded. */
  height: number;
  /** Previous-tick pose, for interpolation. */
  prev = { x: 0, z: 0, heading: 0, turret: 0 };
  hp = 1;
  maxHp = 1;
  moving = false;
  /** Smoothed ground speed in m/s (for dust, wakes, banking). */
  speed = 0;
  private lastPos = new THREE.Vector3();
  private yawRate = 0;
  private lastYaw = 0;
  private bank = 0;
  private altitude = 0;
  private bobPhase = Math.random() * 100;
  /** Smoothed change in speed (m/s²): vehicles squat and dip, helicopters pitch with it. */
  private accel = 0;
  private lastSpeed = 0;
  private nose = 0;
  /** Vehicle suspension: slope alignment plus a sprung pitch/roll offset that rocks. */
  private slope = { x: 0, z: 0 };
  private sway = { x: 0, vx: 0, z: 0, vz: 0 };
  /** Meters moved, for the bumps of rough ground and the soldiers' weave. */
  private travel = 0;
  /** Per-soldier quirks: stride speed and a small offset from the sim position (local frame). */
  readonly gait: number;
  private readonly offset = { x: 0, z: 0 };
  private animAcc = 0;
  /** Rigged model shown (vs the instanced far-LOD pose for infantry). */
  rigVisible = true;
  dying = false;
  wreckAge = -1;
  /** Falling/sinking state for air and naval deaths. */
  private fall = { vy: 0, spin: 0 };
  /** Set by the renderer once the death explosion played. */
  deathFxDone = false;
  /** Meters travelled since the last track/wake stamp (renderer bookkeeping). */
  trackAcc = 0;

  constructor(
    readonly id: number,
    readonly def: ViewDef,
    readonly owner: number,
    readonly teamColor: THREE.Color,
    private readonly host: UnitHost,
  ) {
    this.cls = unitClass(def);
    this.scale = this.cls === 'infantry' ? INFANTRY_SCALE : 1;
    // Soldiers of a squad don't march in lockstep: each has its own pace and keeps a little apart.
    this.gait = this.cls === 'infantry' ? 0.88 + idRandom(id, 1) * 0.24 : 1;
    if (this.cls === 'infantry') {
      this.offset.x = (idRandom(id, 2) - 0.5) * 1.6;
      this.offset.z = (idRandom(id, 3) - 0.5) * 1.2;
    }
    this.height = this.cls === 'infantry' ? 1.8 * this.scale : def.radius;
    this.root.userData.entityId = id;
    this.root.add(this.body);
    const girth = this.cls === 'infantry' ? INFANTRY_GIRTH : 1;
    this.body.scale.set(this.scale * girth, this.scale, this.scale * girth);
    const r = def.radius * (this.cls === 'infantry' ? 1.8 : 1);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.15, r * 1.35, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x9dff7a, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, toneMapped: false }),
    );
    this.ring.renderOrder = 5;
    this.ring.visible = false;
    this.root.add(this.ring);
    if (this.cls === 'structure') this.root.add(this.buildFoundation());
    const variants = VARIANTS[def.model];
    loadModel(variants ? variants[id % variants.length] : def.model).then((m) => this.attach(m));
  }

  private edgeMat: THREE.MeshBasicMaterial | null = null;

  /** Neutral buildings change hands when garrisoned: recolor the ownership edge. */
  setEdgeColor(c: THREE.Color): void {
    if (this.edgeMat && !this.edgeMat.color.equals(c)) this.edgeMat.color.copy(c);
  }

  /** Concrete pad under a building with a team-colored edge, so ownership reads from above. */
  private buildFoundation(): THREE.Object3D {
    const [w, d] = this.def.footprint ?? [this.def.radius * 2, this.def.radius * 2];
    const g = new THREE.Group();
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w * 1.04, 1.6, d * 1.04),
      new THREE.MeshStandardMaterial({ color: 0x5b5a54, roughness: 0.95, metalness: 0 }),
    );
    slab.position.y = -0.55;
    slab.receiveShadow = true;
    g.add(slab);
    const edgeMat = new THREE.MeshBasicMaterial({ color: this.teamColor, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
    this.edgeMat = edgeMat;
    const t = 0.5;
    for (const [sx, sz, ex, ez] of [[w, t, 0, d / 2], [w, t, 0, -d / 2], [t, d, w / 2, 0], [t, d, -w / 2, 0]]) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(sx * 1.04, sz).rotateX(-Math.PI / 2), edgeMat);
      bar.position.set(ex * 1.04, 0.28, ez * 1.04);
      bar.renderOrder = 4;
      g.add(bar);
    }
    return g;
  }

  /** Construction progress 0..1; the building rises out of its foundation. */
  build = 1;
  /** Structures stay drawn (as last seen) once explored. */
  seenOnce = false;

  get loaded(): boolean {
    return !!this.model;
  }

  get isAlive(): boolean {
    return !this.dying && this.wreckAge < 0;
  }

  private attach(prepared: PreparedModel): void {
    if (this.wreckAge > 30) return;
    this.prepared = prepared;
    const model = cloneModel(prepared);
    const size = prepared.bounds.getSize(_v);
    this.height = size.y * this.scale;
    // Small prop models standing in for buildings (ruins, trenches) are stretched to their footprint.
    if (this.cls === 'structure' && this.def.footprint) {
      const [fw, fd] = this.def.footprint;
      const len = Math.max(size.x, size.z);
      if (len < Math.max(fw, fd) * 0.6) {
        const aspect = fw / fd;
        if (aspect > 2 || aspect < 0.5) {
          // A long low wall (trench): stretch along its length only.
          const along = size.x >= size.z ? fw / size.x : fd / size.z;
          this.body.scale.set(size.x >= size.z ? along : 1.4, 1.2, size.x >= size.z ? 1.4 : along);
        } else {
          const k = (Math.max(fw, fd) * 0.85) / len;
          this.body.scale.multiplyScalar(k);
          this.height = size.y * k;
        }
      }
    }
    // Big warships come in at real-world length (140-170 m); draw them at a length that matches their
    // footprint in the game, or they cover half a strait.
    if (this.cls === 'ship') {
      const len = Math.max(size.x, size.z);
      const target = this.def.radius * 5.2;
      if (len > target * 1.25) {
        const k = target / len;
        this.body.scale.multiplyScalar(k);
        this.height = size.y * k;
      }
    }
    const band = new THREE.Vector2(prepared.bounds.min.y + size.y * 0.45, prepared.bounds.min.y + size.y * 0.55);
    model.traverse((o) => {
      o.userData.entityId = this.id;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshes.push(mesh);
      mesh.userData.sourceMaterial = mesh.material;
      mesh.material = this.materialFor(mesh.material as THREE.Material, prepared, false, band);
    });
    this.model = model;
    this.buildXray();
    if (this.rigVisible) this.body.add(model);
    if (prepared.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const [state, names] of Object.entries(CLIPS)) {
        const options = names.map((n) => THREE.AnimationClip.findByName(prepared.animations, n)).filter(Boolean);
        // Pick a random death variant when there are several.
        const clip = state === 'death' && options.length > 1 ? options[Math.floor(Math.random() * options.length)] : options[0];
        if (clip) this.actions.set(state, this.mixer.clipAction(clip));
      }
      const fire = this.actions.get('fire');
      if (fire) {
        fire.setLoop(THREE.LoopOnce, 1);
        fire.clampWhenFinished = false;
      }
      const death = this.actions.get('death');
      if (death) {
        death.setLoop(THREE.LoopOnce, 1);
        death.clampWhenFinished = true;
      }
      const s = this.state;
      this.state = undefined;
      if (this.dying) this.playDeath();
      else this.play(s ?? 'idle');
    }
    if (this.def.turretNode) {
      this.turret = model.getObjectByName(this.def.turretNode) ?? undefined;
      this.turretBase = this.turret?.quaternion.clone();
    }
    if (this.wreckAge >= 0 || this.dying) this.setBurnt(this.cls !== 'infantry');
  }

  /** Own units get a see-through silhouette (null removes it). */
  setXray(color: THREE.Color | null): void {
    if (this.cls === 'structure') return;
    this.xrayColor = color;
    this.buildXray();
  }

  private buildXray(): void {
    for (const g of this.xrayMeshes) g.removeFromParent();
    this.xrayMeshes.length = 0;
    if (!this.xrayColor || !this.model || this.dying) return;
    const mat = xrayFor(this.xrayColor);
    for (const mesh of this.meshes) {
      // A clone shares geometry (and, for rigs, the skeleton), so it follows every animated pose.
      const g = mesh.clone(false);
      g.material = mat;
      g.castShadow = false;
      g.receiveShadow = false;
      g.renderOrder = 3;
      g.raycast = () => {};
      mesh.parent?.add(g);
      this.xrayMeshes.push(g);
    }
  }

  private materialFor(src: THREE.Material, prepared: PreparedModel, burnt: boolean, band?: THREE.Vector2): THREE.Material {
    // Bright orange/red roofs on the base buildings are toned down to a weathered military paint.
    if (this.cls === 'structure' && !burnt && /orange|red/i.test(src.name) && (src as THREE.MeshStandardMaterial).color) {
      const m = (src as THREE.MeshStandardMaterial).clone();
      m.color.lerp(new THREE.Color(0x5d5a4e), 0.72);
      return m;
    }
    // Buildings keep their paint (roofs too: a whole team-blue roof is far too loud); only explicit
    // trim materials take the team color. Ownership also shows on the foundation's edge.
    // Generated buildings mark their own team areas (TeamPaint/TeamAccent), like the generated units.
    const generated = src.name === TEAM_PAINT || src.name === TEAM_ACCENT;
    const role =
      this.cls === 'structure' && !generated
        ? /color_|flag|trim|stripe/i.test(src.name) ? 'accent' : 'keep'
        : materialRole(src, src === prepared.primaryMaterial || !prepared.primaryMaterial);
    return teamMaterial(src, role, this.teamColor, burnt, this.cls === 'infantry' ? 0.9 : 2.2, band);
  }

  private setBurnt(burnt: boolean): void {
    if (!this.prepared) return;
    for (const mesh of this.meshes) mesh.material = this.materialFor(mesh.userData.sourceMaterial, this.prepared, burnt);
  }

  private play(state: AnimState): void {
    if (state === this.state) return;
    const next = this.actions.get(state);
    const prev = this.state && this.actions.get(this.state);
    this.state = state;
    if (!next) return;
    next.reset();
    if (this.cls === 'infantry') {
      // Own stride speed and a random point in the cycle, so a squad doesn't step in unison.
      next.timeScale = state === 'move' ? this.gait : 0.85 + idRandom(this.id, 4) * 0.3;
      next.time = Math.random() * next.getClip().duration;
    }
    next.fadeIn(0.25).play();
    prev?.fadeOut(0.25);
  }

  private playDeath(): void {
    const death = this.actions.get('death');
    if (!death || !this.mixer) return;
    for (const [k, a] of this.actions) if (k !== 'death') a.fadeOut(0.15);
    death.reset().fadeIn(0.1).play();
  }

  /** One-shot fire animation on top of idle/move (recoil, rifle kick). */
  playFire(): void {
    const fire = this.actions.get('fire');
    if (!fire || this.dying) return;
    fire.reset().setEffectiveWeight(1).fadeIn(0.03).play();
  }

  setSelected(on: boolean): void {
    this.ring.visible = on;
  }

  get selected(): boolean {
    return this.ring.visible;
  }

  capturePrev(e: EntityState): void {
    this.prev.x = e.pos.x;
    this.prev.z = e.pos.z;
    this.prev.heading = e.heading;
    this.prev.turret = e.turretHeading ?? e.heading;
  }

  /** The sim reported this unit dead: play the death animation; it becomes a wreck once removed. */
  die(): void {
    if (this.dying) return;
    this.dying = true;
    this.ring.visible = false;
    this.buildXray();
    this.rigVisible = true;
    if (this.cls === 'heli' || this.cls === 'jet') this.fall = { vy: this.cls === 'jet' ? -6 : 0, spin: this.cls === 'heli' ? 2.5 : 0.4 };
    if (this.cls !== 'infantry') this.setBurnt(true);
    this.playDeath();
  }

  /** Called when the sim entity is gone. Returns false if the view should be dropped right away. */
  becomeWreck(): boolean {
    if (!this.dying && this.hp > 0) return false;
    if (!this.dying) this.die();
    this.wreckAge = 0;
    return true;
  }

  /** How long a wreck stays before sinking away. */
  get wreckLifetime(): number {
    return this.cls === 'infantry' ? 14 : this.cls === 'ship' ? 25 : this.cls === 'structure' ? 60 : 45;
  }

  get wreckDone(): boolean {
    return this.wreckAge > this.wreckLifetime + 5;
  }

  /** Place the view between the previous and current tick (alpha in [0,1]). */
  /** Pinned by suppression (drawn lying down). */
  prone = false;

  update(e: EntityState, alpha: number, dt: number, animate: boolean): void {
    this.prone = (e.suppression ?? 0) >= SUPPRESS_PINNED;
    this.hp = e.hp;
    this.maxHp = e.maxHp;
    this.moving = e.moving;
    const p = this.prev;
    const x = p.x + (e.pos.x - p.x) * alpha;
    const z = p.z + (e.pos.z - p.z) * alpha;
    const yaw = lerpAngle(p.heading, e.heading, alpha);
    this.place(x, z, yaw, dt);
    if (!this.dying) this.play(e.moving ? 'move' : 'idle');
    this.tickMixer(dt, animate);
    if (this.turret && this.turretBase && e.turretHeading !== undefined) {
      this.easeTurret(lerpAngle(p.turret, e.turretHeading, alpha), dt);
      this.turret.quaternion.copy(this.turretBase).premultiply(_q.setFromAxisAngle(UP, this.turretShown! - yaw));
    }
  }

  /**
   * A critically damped spring toward the sim's turret heading: the turret accelerates into a
   * traverse and settles onto the target instead of following each tick's step. Render only.
   */
  private easeTurret(target: number, dt: number): void {
    const d = this.turretShown === undefined ? 0 : lerpAngle(this.turretShown, target, 1) - this.turretShown;
    // First frame, or a long way off (hidden for a while): jump rather than spin around.
    if (this.turretShown === undefined || Math.abs(d) > 2.6) {
      this.turretShown = target;
      this.turretVel = 0;
      return;
    }
    const step = Math.min(dt, 0.05);
    const k = 90;
    this.turretVel += (d * k - this.turretVel * 2 * Math.sqrt(k)) * step;
    this.turretShown += this.turretVel * step;
  }

  /** Advance a wreck (no sim entity any more). */
  updateWreck(dt: number, animate: boolean): void {
    this.wreckAge += dt;
    this.updateFalling(dt);
    this.tickMixer(dt, animate);
    // After its lifetime the wreck sinks into the ground (or water) and is removed.
    const sink = Math.max(0, this.wreckAge - this.wreckLifetime);
    if (sink > 0) this.body.position.y = -sink * (this.height / 4 + 0.3);
  }

  private tickMixer(dt: number, animate: boolean): void {
    if (!this.mixer) return;
    this.animAcc += dt;
    // The renderer throttles far/off-screen rigs by passing animate=false on some frames.
    if (!animate) return;
    this.mixer.update(this.animAcc);
    this.animAcc = 0;
  }

  private place(x: number, z: number, yaw: number, dt: number): void {
    const r = this.root;
    const ground = this.host.heightAt(x, z);
    // Speed and turn rate from frame-to-frame motion.
    if (dt > 0) {
      const inst = Math.hypot(x - this.lastPos.x, z - this.lastPos.z) / dt;
      this.speed += (Math.min(inst, 300) - this.speed) * Math.min(1, dt * 5);
      const acc = THREE.MathUtils.clamp((this.speed - this.lastSpeed) / dt, -40, 40);
      this.accel += (acc - this.accel) * Math.min(1, dt * 6);
      this.lastSpeed = this.speed;
      this.travel += this.speed * dt;
      let dy = yaw - this.lastYaw;
      if (dy > Math.PI) dy -= Math.PI * 2;
      if (dy < -Math.PI) dy += Math.PI * 2;
      this.yawRate += (dy / dt - this.yawRate) * Math.min(1, dt * 4);
    }
    this.lastPos.set(x, 0, z);
    this.lastYaw = yaw;
    r.rotation.y = yaw;

    switch (this.cls) {
      case 'structure': {
        // Sit on the lowest corner so the foundation never floats; the slab hides the rest.
        const [w, d] = this.def.footprint ?? [this.def.radius * 2, this.def.radius * 2];
        const s = Math.sin(yaw);
        const c = Math.cos(yaw);
        let low = ground;
        for (const [ox, oz] of [[w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
          low = Math.min(low, this.host.heightAt(x + ox * c + oz * s, z - ox * s + oz * c));
        }
        r.position.set(x, low * 0.6 + ground * 0.4, z);
        const k = this.build >= 1 ? 1 : 0.05 + 0.95 * this.build;
        this.body.scale.set(this.scale, this.scale * k, this.scale);
        break;
      }
      case 'infantry': {
        r.position.set(x, ground, z);
        // Pinned infantry hit the dirt: the rig tips forward onto the ground.
        const want = this.prone ? 1.35 : 0;
        this.body.rotation.x += (want - this.body.rotation.x) * Math.min(1, dt * 6);
        this.body.position.y = this.body.rotation.x * 0.12;
        // Spread a little off the sim position, with a slight weave while on the move.
        const weave = this.moving ? Math.sin(this.travel * 0.35 + this.gait * 40) * 0.25 : 0;
        this.body.position.x = this.offset.x + weave;
        this.body.position.z = this.offset.z;
        break;
      }
      case 'vehicle': {
        r.position.set(x, ground, z);
        // Align to the slope under the hull.
        const d = Math.max(this.def.radius * 0.8, 1);
        const s = Math.sin(yaw);
        const c = Math.cos(yaw);
        const hf = this.host.heightAt(x + s * d, z + c * d);
        const hb = this.host.heightAt(x - s * d, z - c * d);
        const hl = this.host.heightAt(x + c * d, z - s * d);
        const hr = this.host.heightAt(x - c * d, z + s * d);
        const pitch = Math.atan2(hf - hb, 2 * d);
        const roll = Math.atan2(hl - hr, 2 * d);
        const k = Math.min(1, dt * 8);
        this.slope.x += (-pitch - this.slope.x) * k;
        this.slope.z += (roll - this.slope.z) * k;
        this.suspension(dt, (Math.abs(hf + hb - 2 * ground) + Math.abs(hl + hr - 2 * ground)) / d);
        this.body.rotation.x = this.slope.x + this.sway.x;
        this.body.rotation.z = this.slope.z + this.sway.z;
        break;
      }
      case 'heli':
      case 'jet': {
        const cruise = this.cls === 'jet' ? 42 : 18;
        const floor = Math.max(ground, WATER_LEVEL);
        this.altitude += (cruise - this.altitude) * Math.min(1, dt * 0.8);
        const bob = this.cls === 'heli' ? Math.sin((this.bobPhase += dt * 1.3)) * 0.4 : 0;
        r.position.set(x, floor + this.altitude + bob, z);
        // Helicopters lean into turns harder the faster they go, dip the nose to speed up and flare
        // to slow down. Jets bank on turn rate alone.
        const heli = this.cls === 'heli';
        const targetBank = heli
          ? THREE.MathUtils.clamp(-this.yawRate * 0.25 - this.yawRate * this.speed * 0.022, -0.65, 0.65)
          : THREE.MathUtils.clamp(-this.yawRate * 0.9, -0.9, 0.9);
        this.bank += (targetBank - this.bank) * Math.min(1, dt * 3);
        const targetNose = heli ? Math.min(this.speed / 40, 0.22) + THREE.MathUtils.clamp(this.accel * 0.03, -0.22, 0.2) : 0;
        this.nose += (targetNose - this.nose) * Math.min(1, dt * 2.5);
        this.body.rotation.set(this.nose, 0, this.bank);
        break;
      }
      case 'ship': {
        this.bobPhase += dt;
        const t = this.bobPhase;
        r.position.set(x, WATER_LEVEL + Math.sin(t * 0.9) * 0.18 + Math.sin(t * 1.7) * 0.07, z);
        this.body.rotation.x = Math.sin(t * 0.7) * 0.025;
        this.body.rotation.z = Math.sin(t * 0.55 + 1) * 0.04 + THREE.MathUtils.clamp(-this.yawRate * 0.15, -0.12, 0.12);
        break;
      }
    }
    this.ring.position.y = this.cls === 'heli' || this.cls === 'jet' ? Math.max(ground, WATER_LEVEL) - r.position.y + 0.2 : 0.15;
  }

  /**
   * Sprung pitch and roll on top of the slope: the hull squats when pulling away, dips when braking,
   * leans out of turns and rocks over rough ground. `rough` is the local terrain curvature.
   */
  private suspension(dt: number, rough: number): void {
    const moving = Math.min(this.speed / 8, 1);
    const seed = this.id * 1.7;
    const bumps = (Math.sin(this.travel * 1.3 + seed) * 0.6 + Math.sin(this.travel * 2.9 + seed * 2) * 0.4) * moving * (0.25 + Math.min(rough * 3, 1.25));
    const heavy = this.def.armor === 'heavy' ? 0.6 : 1;
    const wantX = (THREE.MathUtils.clamp(-this.accel * 0.012, -0.08, 0.08) + bumps * 0.014) * heavy;
    const wantZ = (THREE.MathUtils.clamp(this.yawRate * this.speed * 0.006, -0.07, 0.07) + bumps * 0.008) * heavy;
    // Underdamped spring: overshoots a little, so stops and starts rock the hull.
    const k = 70;
    const c = 8;
    const s = this.sway;
    for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 60) {
      const h = Math.min(left, 1 / 60);
      s.vx += ((wantX - s.x) * k - s.vx * c) * h;
      s.vz += ((wantZ - s.z) * k - s.vz * c) * h;
      s.x += s.vx * h;
      s.z += s.vz * h;
    }
  }

  private updateFalling(dt: number): void {
    const r = this.root;
    if (this.cls === 'heli' || this.cls === 'jet') {
      const ground = Math.max(this.host.heightAt(r.position.x, r.position.z), WATER_LEVEL);
      if (r.position.y > ground + 0.2) {
        this.fall.vy -= 14 * dt;
        r.position.y = Math.max(ground, r.position.y + this.fall.vy * dt);
        r.rotation.y += this.fall.spin * dt;
        this.body.rotation.x += dt * 0.4;
        if (this.cls === 'jet') {
          r.position.x += Math.sin(r.rotation.y) * 40 * dt;
          r.position.z += Math.cos(r.rotation.y) * 40 * dt;
        }
      }
    } else if (this.cls === 'ship') {
      // Settle and list over before going under.
      this.body.rotation.z += (0.35 - this.body.rotation.z) * dt * 0.2;
      this.body.rotation.x += (0.12 - this.body.rotation.x) * dt * 0.2;
      r.position.y -= dt * 0.25;
    }
  }

  /** True once a falling aircraft has hit the ground (the renderer then plays the crash blast). */
  get crashed(): boolean {
    if (this.cls !== 'heli' && this.cls !== 'jet') return true;
    const r = this.root.position;
    return r.y <= Math.max(this.host.heightAt(r.x, r.z), WATER_LEVEL) + 0.25;
  }

  /** Approximate world-space muzzle position and direction for muzzle flashes. */
  muzzle(outPos: THREE.Vector3, outDir: THREE.Vector3, turretHeading?: number): void {
    const yaw = turretHeading ?? this.root.rotation.y;
    outDir.set(Math.sin(yaw), 0, Math.cos(yaw));
    const r = this.root.position;
    if (this.cls === 'infantry') {
      outPos.set(r.x, r.y + 1.3 * this.scale, r.z).addScaledVector(outDir, 0.75 * this.scale);
    } else {
      const reach = this.def.turretNode ? this.def.radius * 1.55 : this.def.radius * 1.05;
      outPos.set(r.x, r.y + this.height * 0.62, r.z).addScaledVector(outDir, reach);
    }
  }

  /** Full model vs far-LOD instance. The hidden model is detached so it costs no matrix updates. */
  setRigVisible(on: boolean): void {
    if (on === this.rigVisible) return;
    this.rigVisible = on;
    if (!this.model) return;
    if (on) this.body.add(this.model);
    else this.body.remove(this.model);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.xrayColor = null;
    this.buildXray();
    this.mixer?.stopAllAction();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
