import * as THREE from 'three';
import type { MapDef, MapProp } from '../shared/data';
import { DEEP_WATER, shapeBounds, shapeDistance, type MapShape, type TerrainModel } from '../shared/terrain';
import { loadModel } from './models';

/** Tree mixes per terrain style. */
const TREES: Record<string, string[]> = {
  temperate: ['models/env/tree_oak.glb', 'models/env/tree_detailed.glb', 'models/env/tree_default.glb', 'models/env/tree_fat.glb', 'models/env/tree_pine_round.glb'],
  coastal: ['models/env/tree_pine_tall.glb', 'models/env/tree_pine_round.glb', 'models/env/tree_pine_small.glb', 'models/env/tree_default.glb'],
  desert: ['models/env/tree_default.glb', 'models/env/tree_fat.glb', 'models/env/bush_large.glb', 'models/env/bush_detailed.glb'],
};
const UNDERGROWTH = ['models/env/bush_small.glb', 'models/env/bush_large.glb', 'models/env/tree_stump.glb'];

/** Small deterministic random so the same map always looks the same. */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000003) / 1000003;
  };
}

interface Placement {
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
}

/**
 * Static map decoration: trees filling the forests the sim knows about, scattered rocks and bushes,
 * the map's props (sandbags, oil tanks, containers) and bridge decks. Everything is instanced per model.
 */
export class Scenery {
  readonly group = new THREE.Group();
  private readonly placements = new Map<string, Placement[]>();
  private readonly meshes: THREE.InstancedMesh[] = [];

  constructor(
    private readonly map: MapDef,
    private readonly terrain: TerrainModel,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly shadows: boolean,
  ) {
    this.group.name = 'scenery';
    const style = terrain.style;
    const r = rng(terrain.def.seed + 101);
    this.plantForests(TREES[style] ?? TREES.temperate, r);
    for (const sc of map.scatter ?? []) this.scatter(sc.models, sc.area, sc.count, sc.scale ?? [0.8, 1.4], r);
    for (const p of map.props ?? []) this.add(p.model, this.place(p));
    this.buildBridges();
    void this.build();
  }

  private place(p: MapProp): Placement {
    return { x: p.x, y: this.heightAt(p.x, p.z), z: p.z, rot: p.rotation ?? 0, scale: p.scale ?? 1 };
  }

  private add(model: string, p: Placement): void {
    let list = this.placements.get(model);
    if (!list) this.placements.set(model, (list = []));
    list.push(p);
  }

  /** Free ground for decoration: dry land, not on roads, cliffs, points or structures. */
  private open(x: number, z: number, margin = 0): boolean {
    const t = this.terrain;
    const half = this.map.size / 2;
    if (Math.abs(x) > half + 300 || Math.abs(z) > half + 300) return false;
    const h = t.height(x, z);
    if (h < 0.4) return false;
    if (t.roads.length && t.isRoad(x, z)) return false;
    if (t.bridges.length && t.bridgeDeck(x, z) !== null) return false;
    for (const p of this.map.points ?? []) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < (p.radius ?? 25) * (p.radius ?? 25) * 0.5) return false;
    for (const s of this.map.structures ?? []) if (Math.abs(s.x - x) < 9 + margin && Math.abs(s.z - z) < 9 + margin) return false;
    for (const s of this.map.spawns) if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < 110 * 110) return false;
    return h > DEEP_WATER;
  }

  private plantForests(models: string[], r: () => number): void {
    const spacing = 6.5;
    for (const shape of this.terrain.forests) {
      const [x0, z0, x1, z1] = shapeBounds(shape);
      for (let z = z0; z <= z1; z += spacing) {
        for (let x = x0; x <= x1; x += spacing) {
          const px = x + (r() - 0.5) * spacing * 0.9;
          const pz = z + (r() - 0.5) * spacing * 0.9;
          const d = shapeDistance(shape, px, pz);
          if (d > 0 || !this.open(px, pz)) continue;
          // Thinner at the edge so woods don't end in a wall.
          if (d > -6 && r() < 0.45) continue;
          const model = models[Math.floor(r() * models.length)];
          this.add(model, { x: px, y: this.heightAt(px, pz) - 0.2, z: pz, rot: r() * Math.PI * 2, scale: 0.85 + r() * 0.5 });
          if (r() < 0.3) {
            const ux = px + (r() - 0.5) * 4;
            const uz = pz + (r() - 0.5) * 4;
            this.add(UNDERGROWTH[Math.floor(r() * UNDERGROWTH.length)], { x: ux, y: this.heightAt(ux, uz), z: uz, rot: r() * 6.28, scale: 0.7 + r() * 0.6 });
          }
        }
      }
    }
  }

  private scatter(models: string[], area: MapShape, count: number, [s0, s1]: [number, number], r: () => number): void {
    const [x0, z0, x1, z1] = shapeBounds(area);
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 6; tries++) {
      const x = x0 + r() * (x1 - x0);
      const z = z0 + r() * (z1 - z0);
      if (shapeDistance(area, x, z) > 0 || !this.open(x, z, 2)) continue;
      if (this.terrain.forests.length && this.terrain.isForest(x, z)) continue;
      const model = models[Math.floor(r() * models.length)];
      this.add(model, { x, y: this.heightAt(x, z) - 0.15, z, rot: r() * Math.PI * 2, scale: s0 + r() * (s1 - s0) });
      placed++;
    }
  }

  /** Concrete decks with railings and piers down to the river bed. */
  private buildBridges(): void {
    const t = this.terrain;
    if (!t.bridges.length) return;
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x4b4a46, roughness: 0.7, metalness: 0.3 });
    for (const b of t.bridges) {
      const ax = b.a[0];
      const az = b.a[1];
      const dx = b.b[0] - ax;
      const dz = b.b[1] - az;
      const len = Math.hypot(dx, dz);
      const w = b.width ?? 10;
      const y = t.deckHeight(b);
      const yaw = Math.atan2(dx, dz);
      const g = new THREE.Group();
      g.position.set(ax + dx / 2, y, az + dz / 2);
      g.rotation.y = yaw;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, len + 6), deckMat);
      deck.position.y = -0.45;
      deck.receiveShadow = true;
      deck.castShadow = true;
      g.add(deck);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, len + 6), railMat);
        rail.position.set(side * (w / 2 - 0.2), 0.45, 0);
        rail.castShadow = true;
        g.add(rail);
      }
      const piers = Math.max(1, Math.floor(len / 22));
      for (let i = 1; i <= piers; i++) {
        const f = i / (piers + 1) - 0.5;
        const px = ax + dx / 2 + Math.sin(yaw) * f * len;
        const pz = az + dz / 2 + Math.cos(yaw) * f * len;
        const ground = t.height(px, pz);
        const hgt = y - ground + 1;
        if (hgt < 1.5) continue;
        const pier = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, hgt, 2.2), deckMat);
        pier.position.set(0, -hgt / 2 - 0.5, f * len);
        pier.castShadow = true;
        g.add(pier);
      }
      this.group.add(g);
    }
  }

  /** Load each model once and draw all its placements as instanced meshes. */
  private async build(): Promise<void> {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const [model, list] of this.placements) {
      let prepared;
      try {
        prepared = await loadModel(model);
      } catch {
        continue;
      }
      prepared.scene.updateMatrixWorld(true);
      prepared.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const local = mesh.matrixWorld.clone();
        const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
        list.forEach((p, i) => {
          q.setFromAxisAngle(up, p.rot);
          m.compose(pos.set(p.x, p.y, p.z), q, scl.setScalar(p.scale)).multiply(local);
          inst.setMatrixAt(i, m);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        inst.castShadow = this.shadows;
        inst.receiveShadow = true;
        this.meshes.push(inst);
        this.group.add(inst);
      });
    }
  }

  setShadows(on: boolean): void {
    for (const m of this.meshes) m.castShadow = on;
  }

  dispose(): void {
    // Geometry/materials belong to the shared model cache; only the instance buffers are ours.
    for (const m of this.meshes) m.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) mesh.geometry.dispose();
    });
  }
}
