import * as THREE from 'three';
import { cloneModel, loadModel, type PreparedModel } from './models';
import type { QualityLevel } from './quality';
import type { UnitView } from './units';

const RUBBLE_MODEL = 'models/buildings/props/rubble_pile.glb';

/** How many vehicle wrecks and rubble piles stay on the battlefield; beyond that the oldest go first. */
const CAPS: Record<QualityLevel, { wrecks: number; rubble: number; trackFade: number }> = {
  low: { wrecks: 8, rubble: 10, trackFade: 0.99 },
  medium: { wrecks: 20, rubble: 24, trackFade: 0.997 },
  high: { wrecks: 35, rubble: 40, trackFade: 0.999 },
  ultra: { wrecks: 60, rubble: 60, trackFade: 0.9995 },
};

/**
 * Battle damage that outlives the fighting: burned-out vehicle wrecks stay where they died, and
 * destroyed buildings leave a low rubble pile, so the front line turns into a scarred battlefield
 * over the match. Craters, scorch and tread marks live in the DecalMap (fixed cost, no cap needed).
 */
export class BattleScars {
  readonly group = new THREE.Group();
  private readonly wrecks: UnitView[] = [];
  private readonly rubble: THREE.Object3D[] = [];
  private rubbleModel?: PreparedModel;
  private caps = CAPS.high;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    loadModel(RUBBLE_MODEL)
      .then((m) => (this.rubbleModel = m))
      .catch(() => undefined);
  }

  /** Seconds-independent per-pass track fade for this quality (see DecalMap.setTrackFade). */
  setQuality(level: QualityLevel): number {
    this.caps = CAPS[level];
    this.trim();
    return this.caps.trackFade;
  }

  /** Vehicles and crashed aircraft keep their wreck for the rest of the match (within the cap). */
  keepWreck(v: UnitView): void {
    if (v.cls !== 'vehicle' && v.cls !== 'heli' && v.cls !== 'jet') return;
    v.keep = true;
    this.wrecks.push(v);
    this.trim();
  }

  /** A destroyed building leaves a rubble pile over its footprint. */
  addRubble(x: number, z: number, w: number, d: number, yaw: number): void {
    const m = this.rubbleModel;
    if (!m) return;
    const pile = cloneModel(m);
    const size = m.bounds.getSize(new THREE.Vector3());
    const sx = (w * 0.85) / Math.max(size.x, 0.1);
    const sz = (d * 0.85) / Math.max(size.z, 0.1);
    pile.scale.set(sx, Math.min(sx, sz) * 0.5, sz);
    pile.position.set(x, this.heightAt(x, z) - 0.05, z);
    pile.rotation.y = yaw;
    pile.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
    });
    this.group.add(pile);
    this.rubble.push(pile);
    this.trim();
  }

  /** Drop wrecks the renderer already disposed (e.g. a wreck that sank on its own). */
  forget(v: UnitView): void {
    const i = this.wrecks.indexOf(v);
    if (i >= 0) this.wrecks.splice(i, 1);
  }

  private trim(): void {
    while (this.wrecks.length > this.caps.wrecks) this.wrecks.shift()!.release();
    while (this.rubble.length > this.caps.rubble) this.rubble.shift()!.removeFromParent();
  }

  dispose(): void {
    this.group.clear();
    this.wrecks.length = 0;
    this.rubble.length = 0;
  }
}
