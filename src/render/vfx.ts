import * as THREE from 'three';
import { DecalKind, type DecalMap } from './decals';
import { randRange as rr } from './noise';
import { createSmokeTexture, ParticleMode, ParticlePool } from './particles';
import type { QualitySettings } from './quality';
import { WATER_LEVEL } from './terrain';

export type MuzzleSize = 'small' | 'medium' | 'large';

interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  arc: number;
  last: THREE.Vector3;
  trailAcc: number;
}

export interface Emitter {
  follow?: THREE.Object3D;
  pos: THREE.Vector3;
  /** Seconds left; Infinity until stopped. */
  life: number;
  age: number;
  smokeRate: number;
  fireTime: number;
  acc: number;
  fireAcc: number;
  scale: number;
}

interface FlashLight {
  light: THREE.PointLight;
  t: number;
  dur: number;
  peak: number;
}

export interface VfxHost {
  heightAt(x: number, z: number): number;
  decals: DecalMap;
  /** Called for big blasts so the camera can shake by distance. */
  shake(strength: number, x: number, z: number): void;
}

const WIND = new THREE.Vector3(1.1, 0, 0.5);

/** Effect recipes on top of two GPU particle pools (additive light + alpha smoke/debris). */
export class Vfx {
  readonly group = new THREE.Group();
  private readonly additive: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly flights: Flight[] = [];
  private readonly emitters: Emitter[] = [];
  private lights: FlashLight[] = [];
  private amount = 1;
  private time = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly host: VfxHost,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
  ) {
    const smokeTex = createSmokeTexture();
    this.additive = new ParticlePool(6000, 'additive', null, sunDir, sunColor);
    this.smoke = new ParticlePool(9000, 'smoke', smokeTex, sunDir, sunColor);
    this.group.add(this.smoke.mesh, this.additive.mesh);
  }

  setQuality(q: QualitySettings): void {
    this.amount = q.particles;
    for (const l of this.lights) this.group.remove(l.light);
    this.lights = [];
    for (let i = 0; i < q.flashLights; i++) {
      const light = new THREE.PointLight(0xffa04a, 0, 45, 1.6);
      this.group.add(light);
      this.lights.push({ light, t: 1, dur: 1, peak: 0 });
    }
  }

  private n(count: number): number {
    const v = count * this.amount;
    return Math.floor(v) + (Math.random() < v % 1 ? 1 : 0);
  }

  private flash(x: number, y: number, z: number, peak: number, dur: number): void {
    if (!this.lights.length) return;
    // Reuse the light closest to finishing.
    let best = this.lights[0];
    for (const l of this.lights) if (l.t / l.dur > best.t / best.dur) best = l;
    best.light.position.set(x, y, z);
    best.t = 0;
    best.dur = dur;
    best.peak = peak;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, size: MuzzleSize): void {
    const k = size === 'large' ? 2 : size === 'medium' ? 1.1 : 0.45;
    const a = this.additive;
    a.spawn({ x: pos.x, y: pos.y, z: pos.z, life: 0.07, size0: k * 1.6, size1: k * 2.2, r: 9, g: 6, b: 3 });
    a.spawn({
      x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 60 * k, vy: dir.y * 60 * k, vz: dir.z * 60 * k,
      life: 0.06, size0: k * 0.7, size1: k * 0.5, r: 8, g: 5, b: 2.2, spin: 0.012, mode: ParticleMode.Stretched,
    });
    const puffs = this.n(size === 'small' ? 1 : size === 'medium' ? 3 : 7);
    for (let i = 0; i < puffs; i++) {
      const s = rr(2, 6) * k;
      this.smoke.spawn({
        x: pos.x, y: pos.y, z: pos.z, vx: dir.x * s + rr(-1, 1), vy: dir.y * s + rr(0.3, 1.2), vz: dir.z * s + rr(-1, 1),
        life: rr(0.8, 1.5) * k, size0: k * 0.5, size1: k * rr(1.4, 2.4), r: 0.3, g: 0.29, b: 0.27, a: 0.3, drag: 2.2, spin: 0.5,
      });
    }
    if (size === 'large') {
      // Blast kicks up dust around the muzzle.
      const gy = this.host.heightAt(pos.x, pos.z);
      for (let i = 0; i < this.n(8); i++) {
        const ang = rr(0, Math.PI * 2);
        const sp = rr(4, 9);
        this.smoke.spawn({
          x: pos.x, y: gy + 0.4, z: pos.z, vx: Math.cos(ang) * sp + dir.x * 5, vy: rr(0.2, 1), vz: Math.sin(ang) * sp + dir.z * 5,
          life: rr(1.2, 2.2), size0: 1, size1: rr(2.5, 4), r: 0.34, g: 0.3, b: 0.24, a: 0.4, drag: 2.5, spin: 0.4,
        });
      }
      this.flash(pos.x, pos.y, pos.z, 30, 0.12);
      this.host.shake(0.12, pos.x, pos.z);
    } else if (size === 'medium') {
      this.flash(pos.x, pos.y, pos.z, 10, 0.08);
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, speed = 450, heavy = false): void {
    const d = this.tmp.subVectors(to, from);
    const dist = d.length();
    if (dist < 1) return;
    d.divideScalar(dist);
    this.additive.spawn({
      x: from.x, y: from.y, z: from.z, vx: d.x * speed, vy: d.y * speed, vz: d.z * speed,
      life: dist / speed, size0: heavy ? 0.35 : 0.12, size1: heavy ? 0.35 : 0.12,
      r: 7, g: 4.2, b: 1.6, spin: heavy ? 0.025 : 0.018, mode: ParticleMode.Stretched,
    });
  }

  /** Visual-only rocket/missile flight with a smoke trail. The sim's impact event draws the blast. */
  rocket(from: THREE.Vector3, to: THREE.Vector3, speed = 110): void {
    const dist = from.distanceTo(to);
    this.flights.push({ from: from.clone(), to: to.clone(), t: 0, dur: Math.max(dist / speed, 0.15), arc: dist * 0.06, last: from.clone(), trailAcc: 0 });
  }

  hitSparks(x: number, y: number, z: number): void {
    for (let i = 0; i < this.n(6); i++) {
      this.additive.spawn({
        x, y, z, vx: rr(-8, 8), vy: rr(2, 10), vz: rr(-8, 8), life: rr(0.15, 0.4), size0: 0.08, size1: 0.05,
        r: 7, g: 4, b: 1.5, gravity: 12, spin: 0.03, mode: ParticleMode.Stretched,
      });
    }
    this.additive.spawn({ x, y, z, life: 0.06, size0: 0.8, size1: 1.2, r: 6, g: 4, b: 2.5 });
  }

  /** Small dirt kick from a bullet/shell landing. */
  groundHit(x: number, z: number): void {
    const y = this.host.heightAt(x, z);
    for (let i = 0; i < this.n(3); i++) {
      this.smoke.spawn({
        x, y: y + 0.2, z, vx: rr(-1, 1), vy: rr(2, 5), vz: rr(-1, 1), life: rr(0.6, 1.1), size0: 0.4, size1: rr(1, 2),
        r: 0.4, g: 0.35, b: 0.28, a: 0.6, gravity: 4, drag: 1.5,
      });
    }
  }

  /** `size` ~1 = shell, 2 = vehicle, 3 = big. Picks a water splash over water. */
  explosion(x: number, z: number, size: number, y?: number): void {
    const gy = this.host.heightAt(x, z);
    if (gy < WATER_LEVEL - 0.3 && (y === undefined || y < WATER_LEVEL + 2)) {
      this.splash(x, z, size);
      return;
    }
    const py = y ?? gy + 0.6 * size;
    const s = size;
    const a = this.additive;
    // Lifted by its radius so the sprite doesn't slice into the ground.
    a.spawn({ x, y: py + s * 1.6, z, life: 0.13, size0: s * 3.2, size1: s * 4.5, r: 12, g: 8, b: 4.5 });
    for (let i = 0; i < this.n(7 * s); i++) {
      const v = rr(2, 6) * s;
      const ang = rr(0, Math.PI * 2);
      a.spawn({
        x: x + rr(-0.5, 0.5) * s, y: py + rr(0, 0.8) * s, z: z + rr(-0.5, 0.5) * s,
        vx: Math.cos(ang) * v, vy: rr(1, 4) * s, vz: Math.sin(ang) * v,
        life: rr(0.3, 0.6), size0: s * rr(1.5, 2.5), size1: s * rr(3.5, 5.5), r: 5, g: 1.9, b: 0.45, drag: 4, delay: rr(0, 0.05),
      });
    }
    for (let i = 0; i < this.n(10 * s); i++) {
      const ang = rr(0, Math.PI * 2);
      const v = rr(0.5, 3) * s;
      const gray = rr(0.07, 0.14);
      this.smoke.spawn({
        x: x + rr(-1, 1) * s, y: py + rr(0, 1.5) * s, z: z + rr(-1, 1) * s,
        vx: Math.cos(ang) * v + WIND.x, vy: rr(2, 5) * s * 0.7, vz: Math.sin(ang) * v + WIND.z,
        life: rr(3, 6), size0: s * 1.2, size1: s * rr(3.5, 6), r: gray, g: gray * 0.95, b: gray * 0.9, a: 0.8,
        drag: 0.9, gravity: -0.4, spin: rr(-0.4, 0.4), delay: rr(0.03, 0.2),
      });
    }
    for (let i = 0; i < this.n(10 * s); i++) {
      const ang = rr(0, Math.PI * 2);
      const v = rr(6, 14) * Math.sqrt(s);
      this.smoke.spawn({
        x, y: py, z, vx: Math.cos(ang) * v * 0.6, vy: rr(6, 15) * Math.sqrt(s), vz: Math.sin(ang) * v * 0.6,
        life: rr(1.2, 2.2), size0: 0.22 * s, size1: 0.18 * s, r: 0.06, g: 0.055, b: 0.05, gravity: 22, mode: ParticleMode.Chunk,
      });
    }
    for (let i = 0; i < this.n(14); i++) {
      a.spawn({
        x, y: py, z, vx: rr(-20, 20), vy: rr(6, 24), vz: rr(-20, 20), life: rr(0.4, 0.9), size0: 0.1, size1: 0.06,
        r: 8, g: 4, b: 1.4, gravity: 14, drag: 0.6, spin: 0.03, mode: ParticleMode.Stretched,
      });
    }
    a.spawn({ x, y: gy + 0.5, z, life: 0.38, size0: s * 1.5, size1: s * 16, r: 1.6, g: 1.4, b: 1.2, a: 0.8, mode: ParticleMode.Flat });
    for (let i = 0; i < this.n(12); i++) {
      const ang = (i / 12) * Math.PI * 2 + rr(-0.2, 0.2);
      const v = rr(7, 12) * s;
      this.smoke.spawn({
        x, y: gy + 0.6, z, vx: Math.cos(ang) * v, vy: rr(0.3, 1.2), vz: Math.sin(ang) * v,
        life: rr(1.4, 2.4), size0: s * 1, size1: s * rr(2.5, 4), r: 0.36, g: 0.31, b: 0.25, a: 0.45, drag: 2.4, spin: 0.3,
      });
    }
    this.host.decals.stamp(DecalKind.Scorch, x, z, s * 7, s * 7, rr(0, Math.PI * 2), Math.min(1, 0.55 + s * 0.2));
    this.flash(x, py + 2, z, 60 * s, 0.35);
    this.host.shake(0.25 * s, x, z);
  }

  splash(x: number, z: number, size: number): void {
    const s = size;
    const y = WATER_LEVEL + 0.1;
    for (let i = 0; i < this.n(16 * s); i++) {
      const ang = rr(0, Math.PI * 2);
      const v = rr(0.5, 2.5) * s;
      this.smoke.spawn({
        x: x + rr(-0.6, 0.6) * s, y, z: z + rr(-0.6, 0.6) * s, vx: Math.cos(ang) * v, vy: rr(8, 18) * Math.sqrt(s), vz: Math.sin(ang) * v,
        life: rr(1, 1.8), size0: s * 0.8, size1: s * rr(2, 3.5), r: 0.85, g: 0.9, b: 0.95, a: 0.8, gravity: 16, drag: 0.4,
      });
    }
    this.additive.spawn({ x, y: y + 0.2, z, life: 0.6, size0: s * 2, size1: s * 14, r: 0.9, g: 1, b: 1.05, a: 0.6, mode: ParticleMode.Flat });
    this.host.decals.stamp(DecalKind.Wake, x, z, s * 10, s * 10, 0, 1);
    this.host.shake(0.12 * s, x, z);
  }

  /** Smoke column (and a short fire) from a wreck. Follows `follow` if given. */
  smokeColumn(pos: THREE.Vector3, scale: number, duration: number, follow?: THREE.Object3D): Emitter {
    const e: Emitter = { follow, pos: pos.clone(), life: duration, age: 0, smokeRate: 7 * scale, fireTime: 10, acc: 0, fireAcc: 0, scale };
    this.emitters.push(e);
    return e;
  }

  stopEmitter(e: Emitter): void {
    e.life = Math.min(e.life, 0);
  }

  /** Dust kicked up behind a moving ground vehicle; call every frame with its speed. */
  dust(x: number, z: number, speed: number, size: number, dt: number): void {
    const rate = speed * 0.5 * size * this.amount;
    if (Math.random() > rate * dt) return;
    const y = this.host.heightAt(x, z);
    this.smoke.spawn({
      x: x + rr(-0.6, 0.6) * size, y: y + 0.3, z: z + rr(-0.6, 0.6) * size, vx: rr(-0.4, 0.4) + WIND.x * 0.4, vy: rr(0.4, 1.4), vz: rr(-0.4, 0.4) + WIND.z * 0.4,
      life: rr(1.6, 2.8), size0: size * 0.8, size1: size * rr(2.5, 4), r: 0.5, g: 0.44, b: 0.35, a: 0.32, drag: 0.8, spin: 0.25,
    });
  }

  /** Bow spray for ships. */
  spray(x: number, z: number, speed: number, dt: number): void {
    if (Math.random() > speed * 0.8 * this.amount * dt) return;
    this.smoke.spawn({
      x: x + rr(-1, 1), y: WATER_LEVEL + 0.3, z: z + rr(-1, 1), vx: rr(-1.5, 1.5), vy: rr(1.5, 3.5), vz: rr(-1.5, 1.5),
      life: rr(0.6, 1), size0: 0.6, size1: rr(1.5, 2.5), r: 0.9, g: 0.93, b: 0.96, a: 0.5, gravity: 6,
    });
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.updateFlights(dt);
    this.updateEmitters(dt);
    for (const l of this.lights) {
      l.t += dt;
      const k = Math.max(0, 1 - l.t / l.dur);
      l.light.intensity = l.peak * k * k;
    }
    this.additive.update(t);
    this.smoke.update(t);
  }

  private updateFlights(dt: number): void {
    const p = this.tmp;
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.t += dt;
      const k = Math.min(f.t / f.dur, 1);
      p.lerpVectors(f.from, f.to, k);
      p.y += Math.sin(k * Math.PI) * f.arc;
      // Trail: one puff per ~0.7 m travelled.
      const moved = p.distanceTo(f.last);
      f.trailAcc += moved;
      const dir = moved > 1e-4 ? new THREE.Vector3().subVectors(p, f.last).divideScalar(moved) : new THREE.Vector3();
      while (f.trailAcc > 0.7) {
        f.trailAcc -= 0.7;
        const back = f.trailAcc;
        this.smoke.spawn({
          x: p.x - dir.x * back, y: p.y - dir.y * back, z: p.z - dir.z * back, vx: rr(-0.3, 0.3), vy: rr(0.1, 0.5), vz: rr(-0.3, 0.3),
          life: rr(1.6, 2.6), size0: 0.4, size1: rr(1.8, 2.8), r: 0.62, g: 0.6, b: 0.58, a: 0.55, drag: 1, spin: 0.4,
        });
      }
      this.additive.spawn({ x: p.x, y: p.y, z: p.z, life: 0.05, size0: 1.3, size1: 0.9, r: 9, g: 5, b: 2 });
      f.last.copy(p);
      if (k >= 1) this.flights.splice(i, 1);
    }
  }

  private updateEmitters(dt: number): void {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.age += dt;
      e.life -= dt;
      if (e.life <= -6) {
        this.emitters.splice(i, 1);
        continue;
      }
      if (e.follow) e.follow.getWorldPosition(e.pos);
      // Taper off over the last few seconds.
      const taper = e.life < 0 ? 0 : Math.min(1, e.life / 8);
      e.acc += dt * e.smokeRate * taper * this.amount;
      const s = e.scale;
      while (e.acc >= 1) {
        e.acc -= 1;
        const gray = rr(0.05, 0.11);
        this.smoke.spawn({
          x: e.pos.x + rr(-0.8, 0.8) * s, y: e.pos.y + 1.2 * s, z: e.pos.z + rr(-0.8, 0.8) * s,
          vx: rr(-0.3, 0.3) + WIND.x * 0.6, vy: rr(2.5, 4.5) * s, vz: rr(-0.3, 0.3) + WIND.z * 0.6,
          life: rr(5, 8), size0: 1 * s, size1: rr(5, 8) * s, r: gray, g: gray * 0.96, b: gray * 0.92, a: 0.6,
          drag: 0.25, gravity: -0.15, spin: rr(-0.3, 0.3),
        });
      }
      if (e.age < e.fireTime) {
        e.fireAcc += dt * 14 * this.amount;
        while (e.fireAcc >= 1) {
          e.fireAcc -= 1;
          const k = 1 - e.age / e.fireTime;
          this.additive.spawn({
            x: e.pos.x + rr(-0.7, 0.7) * s, y: e.pos.y + rr(0.4, 1.2) * s, z: e.pos.z + rr(-0.7, 0.7) * s,
            vx: rr(-0.3, 0.3), vy: rr(1.5, 3), vz: rr(-0.3, 0.3), life: rr(0.3, 0.6), size0: rr(1, 1.8) * s * k, size1: 0.3 * s,
            r: 4, g: 1.5, b: 0.35, drag: 1,
          });
        }
      }
    }
  }

  dispose(): void {
    this.additive.dispose();
    this.smoke.dispose();
  }
}
