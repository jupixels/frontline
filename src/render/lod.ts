import * as THREE from 'three';
import type { UnitDef } from '../shared/data';
import { createCamoMaterial, createTintMaterial, materialRole } from './materials';
import { bakeModel, loadModel, type BakeOptions } from './models';
import type { UnitClass, UnitView } from './units';

const CAPACITY = 1024;
/** Seconds per stride frame for the two baked run poses. */
const STRIDE = 0.19;

interface LodPart {
  mesh: THREE.InstancedMesh;
  /** How instance color is used: team camo tint, team accent paint, or not at all. */
  tint: 'team' | 'accent' | null;
}

const camoCache = new Map<number, THREE.Material>();
function instancedCamo(scale: number): THREE.Material {
  let m = camoCache.get(scale);
  if (!m) camoCache.set(scale, (m = createCamoMaterial({ team: new THREE.Color(1, 1, 1), instanced: true, scale })));
  return m;
}

/**
 * Far LOD for one unit type: the model baked into static, simplified poses (soldiers: idle + two run
 * frames; vehicles: rest pose) and drawn as InstancedMeshes shared by every team, with team color
 * from instance color. A distant army of one unit type costs a few draw calls and no skinning.
 */
export class LodInstancer {
  readonly group = new THREE.Group();
  private poses: LodPart[][] = [];
  private counts: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(def: UnitDef, cls: UnitClass) {
    void this.build(def, cls);
  }

  private async build(def: UnitDef, cls: UnitClass): Promise<void> {
    const model = await loadModel(def.model);
    const soldier = cls === 'infantry';
    const specs: BakeOptions[] = [];
    if (soldier) {
      const idle = model.animations.find((c) => /MilitaryIdle01|Idle01|Idle/.test(c.name));
      const run = model.animations.find((c) => /Run01_Forward|Walk01_Forward|Run/.test(c.name));
      specs.push({ clip: idle?.name, time: 0.3 });
      if (run) specs.push({ clip: run.name, time: run.duration * 0.25 }, { clip: run.name, time: run.duration * 0.75 });
    } else {
      specs.push({});
    }
    const poses: LodPart[][] = [];
    for (const spec of specs) {
      const geos = await bakeModel(model, { ...spec, detail: soldier ? 0.25 : 0.15, flat: !soldier });
      const parts: LodPart[] = [];
      for (const [src, geo] of geos) {
        const role = materialRole(src, src === model.primaryMaterial || !model.primaryMaterial);
        let material: THREE.Material = src;
        let tint: LodPart['tint'] = null;
        if (role === 'camo') {
          material = instancedCamo(soldier ? 0.9 : 2.2);
          tint = 'team';
        } else if (role === 'tint' || role === 'tintAccent') {
          material = createTintMaterial(src, new THREE.Color(1, 1, 1), role, true);
          tint = 'team';
        } else if (role === 'accent') {
          const accent = (src as THREE.MeshStandardMaterial).clone();
          accent.color.setRGB(1, 1, 1);
          accent.roughness = 0.5;
          accent.map = null;
          material = accent;
          tint = 'accent';
        }
        const mesh = new THREE.InstancedMesh(geo, material, CAPACITY);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (tint) {
          mesh.setColorAt(0, this.c.setRGB(1, 1, 1));
          mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        parts.push({ mesh, tint });
        this.group.add(mesh);
      }
      poses.push(parts);
    }
    this.poses = poses;
    this.counts = poses.map(() => 0);
  }

  get ready(): boolean {
    return this.poses.length > 0;
  }

  begin(): void {
    this.counts.fill(0);
  }

  add(view: UnitView, time: number): void {
    if (!this.poses.length) return;
    let pose = 0;
    if (view.moving && this.poses.length > 2) pose = 1 + (Math.floor(time / STRIDE + view.id * 0.37) % 2);
    const i = this.counts[pose];
    if (i >= CAPACITY) return;
    // root carries position + yaw, body carries terrain tilt/bank and scale.
    this.q.multiplyQuaternions(view.root.quaternion, view.body.quaternion);
    this.s.copy(view.body.scale);
    this.m.compose(this.p.copy(view.root.position).add(view.body.position), this.q, this.s);
    for (const part of this.poses[pose]) {
      part.mesh.setMatrixAt(i, this.m);
      if (part.tint === 'team') part.mesh.setColorAt(i, view.teamColor);
      else if (part.tint === 'accent') part.mesh.setColorAt(i, this.c.copy(view.teamColor).multiplyScalar(0.55));
    }
    this.counts[pose] = i + 1;
  }

  end(): void {
    this.poses.forEach((parts, k) => {
      const n = this.counts[k];
      for (const { mesh } of parts) {
        mesh.count = n;
        if (!n) continue;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, n * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
    });
  }
}
