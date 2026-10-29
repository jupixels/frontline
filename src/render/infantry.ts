import * as THREE from 'three';
import { createCamoMaterial } from './materials';
import { bakePose, loadModel } from './models';
import { INFANTRY_SCALE, type UnitView } from './units';

const CAPACITY = 2048;
/** Seconds per stride frame for the two baked run poses. */
const STRIDE = 0.19;

/**
 * Far-LOD infantry: the soldier model baked into static poses (idle + two run frames) and drawn with
 * one InstancedMesh per pose for all teams; team color comes from instance color. Hundreds of distant
 * soldiers cost three draw calls and no skinning.
 */
export class InfantryInstancer {
  readonly group = new THREE.Group();
  private poses: THREE.InstancedMesh[] = [];
  private counts: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(INFANTRY_SCALE, INFANTRY_SCALE, INFANTRY_SCALE);
  private readonly axis = new THREE.Vector3(0, 1, 0);

  constructor(modelPath: string) {
    loadModel(modelPath).then((model) => {
      const material = createCamoMaterial({ team: new THREE.Color(1, 1, 1), instanced: true, scale: 0.9 });
      const idle = model.animations.find((c) => /MilitaryIdle01|Idle01|Idle/.test(c.name))?.name ?? '';
      const run = model.animations.find((c) => /Run01_Forward|Walk01_Forward|Run/.test(c.name));
      const geos = [bakePose(model, idle, 0.3)];
      if (run) geos.push(bakePose(model, run.name, run.duration * 0.25), bakePose(model, run.name, run.duration * 0.75));
      for (const g of geos) {
        const mesh = new THREE.InstancedMesh(g, material, CAPACITY);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, new THREE.Color());
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.poses.push(mesh);
        this.group.add(mesh);
      }
      this.counts = this.poses.map(() => 0);
    });
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
    if (view.moving && this.poses.length > 1) pose = 1 + (Math.floor(time / STRIDE + view.id * 0.37) % 2);
    const i = this.counts[pose];
    if (i >= CAPACITY) return;
    const mesh = this.poses[pose];
    this.q.setFromAxisAngle(this.axis, view.root.rotation.y);
    this.m.compose(view.root.position, this.q, this.s);
    mesh.setMatrixAt(i, this.m);
    mesh.setColorAt(i, view.teamColor);
    this.counts[pose] = i + 1;
  }

  end(): void {
    this.poses.forEach((mesh, k) => {
      mesh.count = this.counts[k];
      if (mesh.count) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, mesh.count * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    });
  }
}
