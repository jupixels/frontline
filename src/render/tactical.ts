import * as THREE from 'three';
import type { FrontlineView } from '../shared/entities';
import type { EntityId } from '../shared/types';
import { cloneModel, loadModel } from './models';

/** Missile arc height as a fraction of its flight distance (pass the same to Vfx.rocket). */
export const MISSILE_ARC = 0.22;

/** Chevron / garrison label textures, drawn once per key. */
const textures = new Map<string, THREE.CanvasTexture>();

function badgeTexture(key: string): THREE.CanvasTexture {
  let t = textures.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  if (key.startsWith('r')) {
    // Veterancy: 1-3 gold chevrons.
    const n = Number(key.slice(1));
    for (let i = 0; i < n; i++) {
      const y = 34 - i * 11;
      g.beginPath();
      g.moveTo(26, y);
      g.lineTo(48, y - 12);
      g.lineTo(70, y);
      g.lineWidth = 9;
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.stroke();
      g.lineWidth = 5;
      g.strokeStyle = '#f1c75a';
      g.stroke();
    }
  } else {
    // Garrison: a shield with the occupant count.
    g.fillStyle = 'rgba(10,14,10,0.8)';
    g.strokeStyle = '#c9f5b6';
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(14, 6, 68, 36, 8);
    g.fill();
    g.stroke();
    g.fillStyle = '#e8ffe0';
    g.font = 'bold 26px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`▲${key.slice(1)}`, 48, 25);
  }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, t);
  return t;
}

interface Flight {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  dur: number;
}

/**
 * Tactical overlays drawn in the world: veterancy chevrons and garrison counts over units and
 * buildings, frontline ribbons (with a facing arrow) in team color, and cruise missiles in flight.
 */
export class TacticalLayer {
  readonly group = new THREE.Group();
  private readonly badges = new Map<EntityId, THREE.Sprite>();
  private readonly lines = new Map<number, { key: string; obj: THREE.Group }>();
  private readonly flights: Flight[] = [];
  private seen = new Set<EntityId>();

  constructor(
    private readonly heightAt: (x: number, z: number) => number,
    private readonly colorOf: (owner: number) => THREE.Color,
  ) {
    this.group.name = 'tactical';
  }

  /** Call once per frame before `badge()` calls. */
  begin(): void {
    this.seen = new Set();
  }

  /** Show `key` ('r2' = rank 2, 'g4' = 4 in garrison) above an entity at `pos`. */
  badge(id: EntityId, key: string, pos: THREE.Vector3, size: number): void {
    let s = this.badges.get(id);
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(key), depthTest: false, transparent: true, toneMapped: false }));
      s.renderOrder = 6;
      s.userData.key = key;
      this.badges.set(id, s);
      this.group.add(s);
    } else if (s.userData.key !== key) {
      s.material.map = badgeTexture(key);
      s.userData.key = key;
    }
    s.position.copy(pos);
    s.scale.set(size * 2, size, 1);
    s.visible = true;
    this.seen.add(id);
  }

  end(): void {
    for (const [id, s] of this.badges) {
      if (this.seen.has(id)) continue;
      this.group.remove(s);
      s.material.dispose();
      this.badges.delete(id);
    }
  }

  /** Frontline ribbons; rebuilt only when a line changes. */
  setLines(lines: readonly FrontlineView[]): void {
    const live = new Set<number>();
    for (const l of lines) {
      live.add(l.id);
      const key = JSON.stringify([l.points, l.owner, l.facing, l.target ?? null]);
      const cur = this.lines.get(l.id);
      if (cur?.key === key) continue;
      if (cur) this.disposeLine(cur.obj);
      const obj = this.buildLine(l);
      // Advancing: a faint copy of the line where it's headed.
      if (l.target) {
        const ghost = this.buildLine({ ...l, points: l.target, target: null });
        ghost.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material & { opacity?: number };
          if (mat && 'opacity' in mat) mat.opacity = 0.32;
        });
        obj.add(ghost);
      }
      this.group.add(obj);
      this.lines.set(l.id, { key, obj });
    }
    for (const [id, cur] of this.lines) {
      if (live.has(id)) continue;
      this.disposeLine(cur.obj);
      this.lines.delete(id);
    }
  }

  private buildLine(l: FrontlineView): THREE.Group {
    const g = new THREE.Group();
    const color = this.colorOf(l.owner);
    // Densify so the ribbon follows the ground.
    const pts: THREE.Vector3[] = [];
    for (let i = 1; i < l.points.length; i++) {
      const a = l.points[i - 1];
      const b = l.points[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
      for (let k = 0; k < n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const z = a.z + ((b.z - a.z) * k) / n;
        pts.push(new THREE.Vector3(x, this.heightAt(x, z) + 0.6, z));
      }
    }
    const last = l.points[l.points.length - 1];
    pts.push(new THREE.Vector3(last.x, this.heightAt(last.x, last.z) + 0.6, last.z));
    // A flat ribbon (GL lines are 1 px), dashed by skipping every third quad.
    const half = 0.9;
    const verts: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      if (i % 3 === 0) continue;
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * half;
      const nz = (dx / len) * half;
      verts.push(a.x + nx, a.y, a.z + nz, a.x - nx, a.y, a.z - nz, b.x + nx, b.y, b.z + nz);
      verts.push(b.x + nx, b.y, b.z + nz, a.x - nx, a.y, a.z - nz, b.x - nx, b.y, b.z - nz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const ribbon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false, side: THREE.DoubleSide }));
    ribbon.renderOrder = 5;
    g.add(ribbon);
    // Facing arrows every ~40 m.
    const fx = Math.sin(l.facing);
    const fz = Math.cos(l.facing);
    const arrowMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false, side: THREE.DoubleSide });
    const step = Math.max(1, Math.round(40 / 4));
    for (let i = Math.floor(step / 2); i < pts.length; i += step) {
      const p = pts[i];
      const shape = new THREE.Shape([new THREE.Vector2(-3, 0), new THREE.Vector2(3, 0), new THREE.Vector2(0, 5.5)]);
      const tri = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2), arrowMat);
      tri.position.set(p.x + fx * 2, p.y, p.z + fz * 2);
      tri.rotation.y = l.facing;
      tri.renderOrder = 5;
      g.add(tri);
    }
    return g;
  }

  private disposeLine(obj: THREE.Group): void {
    this.group.remove(obj);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }

  /** A cruise missile flying from `from` to `to` over `seconds`. */
  launch(from: THREE.Vector3, to: THREE.Vector3, seconds: number, now: number): void {
    const holder = new THREE.Group();
    this.group.add(holder);
    const f: Flight = { obj: holder, from: from.clone(), to: to.clone(), t0: now, dur: Math.max(1, seconds) };
    this.flights.push(f);
    loadModel('models/cruise_missile.glb')
      .then((m) => holder.add(cloneModel(m)))
      .catch(() => holder.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x777777 }))));
  }

  /** Advance missiles; returns positions of those still flying (for smoke trails). */
  update(now: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      const t = (now - f.t0) / f.dur;
      if (t >= 1) {
        this.group.remove(f.obj);
        this.flights.splice(i, 1);
        continue;
      }
      // Same arc as Vfx.rocket (which draws the smoke trail along it).
      const arcH = f.from.distanceTo(f.to) * MISSILE_ARC;
      const p = new THREE.Vector3().lerpVectors(f.from, f.to, t);
      p.y += Math.sin(Math.PI * t) * arcH;
      const t2 = Math.min(1, t + 0.01);
      const q = new THREE.Vector3().lerpVectors(f.from, f.to, t2);
      q.y += Math.sin(Math.PI * t2) * arcH;
      f.obj.position.copy(p);
      f.obj.lookAt(q);
      out.push(p);
    }
    return out;
  }

  dispose(): void {
    for (const s of this.badges.values()) s.material.dispose();
    for (const l of this.lines.values()) this.disposeLine(l.obj);
    this.badges.clear();
    this.lines.clear();
  }
}
