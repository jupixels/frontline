import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { UnitDef } from '../shared/data';
import type { EntityState } from '../shared/entities';
import { assetUrl } from '../shared/view';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<GLTF>>();

export function loadModel(path: string): Promise<GLTF> {
  let p = cache.get(path);
  if (!p) {
    p = loader.loadAsync(assetUrl(path)).then((gltf) => {
      gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return gltf;
    });
    cache.set(path, p);
  }
  return p;
}

/** Clip-name candidates per animation state, first match wins (vehicles vs soldiers differ). */
const CLIPS = {
  idle: ['Idle', 'MilitaryIdle01', 'Idle01', 'Idle_Rotors'],
  move: ['Move', 'Run01_Forward', 'Walk01_Forward', 'Fly'],
};
type AnimState = keyof typeof CLIPS;

/** The visual for one sim entity: model clone, animation mixer, selection ring. */
export class UnitView {
  readonly root = new THREE.Group();
  private mixer?: THREE.AnimationMixer;
  private actions = new Map<AnimState, THREE.AnimationAction>();
  private state?: AnimState;
  private turret?: THREE.Object3D;
  private turretBase?: THREE.Quaternion;
  private readonly ring: THREE.Mesh;
  /** Previous-tick pose, for interpolation. */
  prev = { x: 0, z: 0, heading: 0, turret: 0 };

  constructor(
    readonly id: number,
    readonly def: UnitDef,
    teamColor: THREE.Color,
  ) {
    this.root.userData.entityId = id;
    const r = def.radius;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.15, r * 1.35, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x9dff7a, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.ring.position.y = 0.08;
    this.ring.visible = false;
    this.root.add(this.ring);

    // Small team-color disc so ownership reads at any zoom until proper team-color materials land.
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.95, r * 1.1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    disc.position.y = 0.06;
    this.root.add(disc);

    loadModel(def.model).then((gltf) => this.attach(gltf));
  }

  private attach(gltf: GLTF): void {
    const model = SkeletonUtils.clone(gltf.scene);
    model.traverse((o) => (o.userData.entityId = this.id));
    this.root.add(model);
    if (gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const state of Object.keys(CLIPS) as AnimState[]) {
        const clip = CLIPS[state].map((n) => THREE.AnimationClip.findByName(gltf.animations, n)).find(Boolean);
        if (clip) this.actions.set(state, this.mixer.clipAction(clip));
      }
      const s = this.state;
      this.state = undefined;
      this.play(s ?? 'idle');
    }
    if (this.def.turretNode) {
      this.turret = model.getObjectByName(this.def.turretNode) ?? undefined;
      this.turretBase = this.turret?.quaternion.clone();
    }
  }

  private play(state: AnimState): void {
    if (state === this.state) return;
    const next = this.actions.get(state);
    const prev = this.state && this.actions.get(this.state);
    this.state = state;
    if (!next) return;
    next.reset().fadeIn(0.25).play();
    prev?.fadeOut(0.25);
  }

  setSelected(on: boolean): void {
    this.ring.visible = on;
  }

  capturePrev(e: EntityState): void {
    this.prev.x = e.pos.x;
    this.prev.z = e.pos.z;
    this.prev.heading = e.heading;
    this.prev.turret = e.turretHeading ?? e.heading;
  }

  /** Place the view between the previous and current tick (alpha in [0,1]). */
  update(e: EntityState, alpha: number, dt: number): void {
    const p = this.prev;
    this.root.position.set(p.x + (e.pos.x - p.x) * alpha, 0, p.z + (e.pos.z - p.z) * alpha);
    this.root.rotation.y = lerpAngle(p.heading, e.heading, alpha);
    this.play(e.moving ? 'move' : 'idle');
    this.mixer?.update(dt);
    if (this.turret && this.turretBase && e.turretHeading !== undefined) {
      const local = lerpAngle(p.turret, e.turretHeading, alpha) - this.root.rotation.y;
      this.turret.quaternion.copy(this.turretBase).premultiply(new THREE.Quaternion().setFromAxisAngle(UP, local));
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.mixer?.stopAllAction();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
