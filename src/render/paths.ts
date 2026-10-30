import * as THREE from 'three';
import type { RouteLeg, SimViewExt } from '../shared/entities';
import type { EntityId, PlayerId, Vec2 } from '../shared/types';

/** 'selected': lines for the selection and for a moment after each order. 'all': every own unit with orders. */
export type PathLineMode = 'selected' | 'all';

type Kind = RouteLeg['kind'];

/** Color and dash per order. Dashed lines read as "fight on the way". */
const STYLE: Record<Kind, { color: number; dash: boolean }> = {
  move: { color: 0x8dff6e, dash: false },
  attackMove: { color: 0xff6a3d, dash: true },
  attack: { color: 0xff6a3d, dash: true },
  patrol: { color: 0xffc94a, dash: true },
  unload: { color: 0xc58cff, dash: false },
  enter: { color: 0xc58cff, dash: false },
  build: { color: 0x6ec8ff, dash: false },
  ability: { color: 0xe8ece4, dash: true },
};
const COLORS = Object.fromEntries(Object.entries(STYLE).map(([k, s]) => [k, new THREE.Color(s.color)])) as Record<Kind, THREE.Color>;

/** Units with matching orders closer than this (meters) share one line. */
const MERGE_GOAL = 18;
const MERGE_POS = 32;
/** Re-read routes from the sim every N frames; in between only the start points move. */
const REFRESH_FRAMES = 6;
/** Seconds a line stays after an order for units that are not selected. */
const FLASH_SECONDS = 1.6;
/** Ribbon sample spacing along the ground (meters). */
const STEP = 3;
const LIFT = 0.45;
const RING_SEGMENTS = 24;

/** A sampled ground point of a line: position, height, and distance left to the line's end. */
interface Sample {
  x: number;
  y: number;
  z: number;
  /** Meters from here to the end of the whole route (keeps dashes fixed to the ground). */
  rem: number;
}

interface Strip {
  samples: Sample[];
  kind: Kind;
  /** 1 for the current leg, fainter for queued legs and patrol loops. */
  fade: number;
}

interface Ring {
  at: Vec2;
  radius: number;
  kind: Kind;
  fade: number;
  /** Ground height under each rim point. */
  ys: number[];
  thin: boolean;
}

interface Cluster {
  ids: EntityId[];
  /** Strip 0 is the current leg: the group's position joins it partway along each frame. */
  strips: Strip[];
  rings: Ring[];
  /** 0..1: fades flash-only lines out. */
  alpha: number;
}

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec3 line; // distance left (m), dashed (0/1), alpha
varying vec3 vColor;
varying vec3 vLine;
void main() {
  vColor = aColor;
  vLine = line;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vColor;
varying vec3 vLine;
void main() {
  float rem = vLine.x;
  if (vLine.y > 0.5 && fract((rem + uTime * 6.0) / 5.0) > 0.6) discard;
  // A soft pulse travels toward the destination on solid lines.
  float pulse = vLine.y > 0.5 ? 0.0 : 0.25 * smoothstep(0.75, 1.0, fract((rem + uTime * 9.0) / 16.0));
  gl_FragColor = vec4(vColor * (1.0 + pulse), vLine.z);
}`;

/** Order path lines for own units: one ribbon mesh following the terrain, rebuilt each frame. */
export class PathLines {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private line = new Float32Array(0);
  private index = new Uint32Array(0);
  private nv = 0;
  private ni = 0;
  private clusters: Cluster[] = [];
  private readonly flashes = new Map<EntityId, number>();
  /** Units ordered together share a group (their formation slots can be far apart); queued orders keep it. */
  private readonly orderGroup = new Map<EntityId, number>();
  private nextGroup = 1;
  /** Ground samples per route segment, kept while the segment is still in use. */
  private segments = new Map<string, Sample[]>();
  private prevSegments = new Map<string, Sample[]>();
  private frame = 0;
  mode: PathLineMode = 'selected';

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.grow(4096, 8192);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** An order was just given to these units: group them and show their lines for a moment. */
  flash(ids: Iterable<EntityId>, now: number, queued = false): void {
    const group = this.nextGroup++;
    for (const id of ids) {
      this.flashes.set(id, now + FLASH_SECONDS);
      if (!queued || !this.orderGroup.has(id)) this.orderGroup.set(id, group);
    }
    this.frame = -1;
  }

  /**
   * `posOf` gives a unit's drawn position (null hides it). Only units `player` may command get
   * lines, so enemy routes never show.
   */
  update(ext: SimViewExt | null, player: PlayerId, selection: ReadonlySet<EntityId>, all: () => Iterable<EntityId>, posOf: (id: EntityId) => THREE.Vector3 | null, now: number, width: number): void {
    this.mat.uniforms.uTime.value = now;
    for (const [id, until] of this.flashes) if (until <= now) this.flashes.delete(id);
    if (!ext || player < 0) {
      this.mesh.visible = false;
      return;
    }
    if (this.frame < 0 || this.frame % REFRESH_FRAMES === 0) {
      this.frame = 0;
      this.refresh(ext, player, selection, all, posOf);
    }
    this.frame++;
    for (const c of this.clusters) {
      let flash = 0;
      let selected = false;
      for (const id of c.ids) {
        if (selection.has(id)) selected = true;
        const until = this.flashes.get(id);
        if (until) flash = Math.max(flash, Math.min(1, (until - now) / 0.5));
      }
      c.alpha = selected ? 0.9 : Math.max(flash * 0.9, this.mode === 'all' ? 0.42 : 0);
    }
    this.build(posOf, width);
  }

  /** Group units by order and destination, and sample each group's route onto the ground. */
  private refresh(ext: SimViewExt, player: PlayerId, selection: ReadonlySet<EntityId>, all: () => Iterable<EntityId>, posOf: (id: EntityId) => THREE.Vector3 | null): void {
    const ids = new Set<EntityId>(selection);
    for (const id of this.flashes.keys()) ids.add(id);
    if (this.mode === 'all') for (const id of all()) ids.add(id);
    [this.prevSegments, this.segments] = [this.segments, this.prevSegments];
    this.segments.clear();
    const groups: { gid: number | undefined; first: readonly RouteLeg[]; x: number; z: number; n: number; ids: EntityId[]; legs: (readonly RouteLeg[])[] }[] = [];
    for (const id of ids) {
      if (!ext.canCommand(player, id)) continue;
      const p = posOf(id);
      if (!p) continue;
      const r = ext.route(id, false);
      if (!r) {
        this.orderGroup.delete(id);
        continue;
      }
      const to = r.legs[0].to;
      const gid = this.orderGroup.get(id);
      const g = groups.find(
        (g) =>
          g.gid === gid &&
          g.first.length === r.legs.length &&
          g.first[0].kind === r.legs[0].kind &&
          // Units with no known group (ordered earlier, or by a co-commander) merge by distance.
          (gid !== undefined || (Math.hypot(g.first[0].to.x - to.x, g.first[0].to.z - to.z) < MERGE_GOAL && Math.hypot(g.x / g.n - p.x, g.z / g.n - p.z) < MERGE_POS)),
      );
      if (g) {
        g.ids.push(id);
        g.legs.push(r.legs);
        g.x += p.x;
        g.z += p.z;
        g.n++;
      } else groups.push({ gid, first: r.legs, x: p.x, z: p.z, n: 1, ids: [id], legs: [r.legs] });
    }
    this.clusters = groups.map((g) => {
      // Trace the member nearest the group's middle; its route stands for the group.
      const cx = g.x / g.n;
      const cz = g.z / g.n;
      let lead = g.ids[0];
      let best = Infinity;
      for (const id of g.ids) {
        const p = posOf(id)!;
        const d = (p.x - cx) * (p.x - cx) + (p.z - cz) * (p.z - cz);
        if (d < best) [best, lead] = [d, id];
      }
      const corners = (ext.route(lead)?.path ?? []).slice(0, -1); // the lead's own slot; the group's mean end replaces it
      const legs = g.first.map((leg, i) => {
        let x = 0;
        let z = 0;
        for (const l of g.legs) {
          x += l[i].to.x;
          z += l[i].to.z;
        }
        const to = { x: x / g.n, z: z / g.n };
        let spread = 0;
        for (const l of g.legs) spread = Math.max(spread, Math.hypot(l[i].to.x - to.x, l[i].to.z - to.z));
        return { kind: leg.kind, to, spread };
      });
      // Centerlines, first leg from the group's middle; per frame the head is re-joined to the group.
      const polys: { pts: Vec2[]; kind: Kind; fade: number }[] = [];
      // Snapped to a coarse grid so the first segment's samples stay cached while the group moves.
      let from: Vec2 = { x: Math.round(cx / 8) * 8, z: Math.round(cz / 8) * 8 };
      legs.forEach((leg, i) => {
        polys.push({ pts: i === 0 ? [from, ...corners, leg.to] : [from, leg.to], kind: leg.kind, fade: i === 0 ? 1 : 0.6 });
        from = leg.to;
      });
      // Patrols loop back to where they started.
      if (legs.length >= 2 && legs[legs.length - 1].kind === 'patrol') polys.push({ pts: [from, legs[legs.length - 2].to], kind: 'patrol', fade: 0.6 });
      const strips = polys.map((p) => ({ samples: this.sampleCached(p.pts), kind: p.kind, fade: p.fade }));
      // Distance left to the end of the route, so dashes stay put on the ground as the group advances.
      let rem = 0;
      for (let s = strips.length - 1; s >= 0; s--) {
        const smp = strips[s].samples;
        for (let i = smp.length - 1; i >= 0; i--) {
          if (i < smp.length - 1) rem += Math.hypot(smp[i + 1].x - smp[i].x, smp[i + 1].z - smp[i].z);
          smp[i].rem = rem;
        }
      }
      const rings = legs.map((leg, i) => {
        const last = i === legs.length - 1;
        const radius = Math.max(last ? 1.8 : 1, Math.min(leg.spread + 1, 14));
        const ys: number[] = [];
        for (let k = 0; k <= RING_SEGMENTS; k++) {
          const t = (k / RING_SEGMENTS) * Math.PI * 2;
          ys.push(this.heightAt(leg.to.x + Math.cos(t) * radius, leg.to.z + Math.sin(t) * radius) + LIFT);
        }
        return { at: leg.to, radius, kind: leg.kind, fade: i === 0 ? 1 : 0.6, ys, thin: !last };
      });
      return { ids: g.ids, strips, rings, alpha: 0 };
    });
  }

  /** Like `sample`, but reuses the samples of segments seen at the last refresh (routes mostly stay put). */
  private sampleCached(pts: readonly Vec2[]): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const key = `${Math.round(a.x * 4)},${Math.round(a.z * 4)},${Math.round(b.x * 4)},${Math.round(b.z * 4)}`;
      let seg = this.segments.get(key) ?? this.prevSegments.get(key);
      if (!seg) seg = this.sample([a, b]).slice(0, -1);
      this.segments.set(key, seg);
      for (const p of seg) out.push({ x: p.x, y: p.y, z: p.z, rem: 0 });
    }
    const e = pts[pts.length - 1];
    out.push({ x: e.x, y: this.heightAt(e.x, e.z) + LIFT, z: e.z, rem: 0 });
    return out;
  }

  /** Resample a polyline every STEP meters, with ground heights. */
  private sample(pts: readonly Vec2[], out: Sample[] = []): Sample[] {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / STEP));
      for (let k = 0; k < n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const z = a.z + ((b.z - a.z) * k) / n;
        out.push({ x, y: this.heightAt(x, z) + LIFT, z, rem: 0 });
      }
    }
    const e = pts[pts.length - 1];
    out.push({ x: e.x, y: this.heightAt(e.x, e.z) + LIFT, z: e.z, rem: 0 });
    return out;
  }

  private build(posOf: (id: EntityId) => THREE.Vector3 | null, width: number): void {
    this.nv = 0;
    this.ni = 0;
    for (const c of this.clusters) {
      if (c.alpha <= 0.01 || !c.strips.length) continue;
      let x = 0;
      let z = 0;
      let n = 0;
      for (const id of c.ids) {
        const p = posOf(id);
        if (!p) continue;
        x += p.x;
        z += p.z;
        n++;
      }
      if (!n) continue;
      x /= n;
      z /= n;
      // Join the group to the first sample of the current leg it has not passed yet.
      const head = c.strips[0].samples;
      const end = head[head.length - 1];
      const left = Math.hypot(end.x - x, end.z - z);
      let i = 0;
      while (i < head.length - 1 && Math.hypot(end.x - head[i].x, end.z - head[i].z) >= left) i++;
      const next = head[i];
      const lead = this.sample([{ x, z }, next]);
      const gap = Math.hypot(next.x - x, next.z - z);
      for (const s of lead) s.rem = next.rem + Math.hypot(next.x - s.x, next.z - s.z) * (gap > 0 ? 1 : 0);
      c.strips.forEach((s, k) => {
        const samples = k === 0 ? lead.concat(head.slice(i + 1)) : s.samples;
        this.ribbon(samples, COLORS[s.kind], STYLE[s.kind].dash, c.alpha * s.fade, width, k === 0);
      });
      for (const r of c.rings) this.ring(r, c.alpha * r.fade, width * (r.thin ? 0.7 : 1));
    }
    this.mesh.visible = this.ni > 0;
    this.geo.setDrawRange(0, this.ni);
    for (const k of ['position', 'aColor', 'line'] as const) {
      const attr = this.geo.getAttribute(k) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, this.nv * 3);
      attr.needsUpdate = true;
    }
    const idx = this.geo.getIndex()!;
    idx.clearUpdateRanges();
    idx.addUpdateRange(0, this.ni);
    idx.needsUpdate = true;
  }

  /** A ground-hugging strip through `samples`. `growIn` fades the first meters so it rises out of the group. */
  private ribbon(samples: readonly Sample[], color: THREE.Color, dash: boolean, alpha: number, width: number, growIn: boolean): void {
    if (samples.length < 2) return;
    this.reserve(samples.length * 2, (samples.length - 1) * 6);
    const base = this.nv;
    const h = width * 0.5;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const q0 = samples[Math.max(0, i - 1)];
      const q1 = samples[Math.min(samples.length - 1, i + 1)];
      let dx = q1.x - q0.x;
      let dz = q1.z - q0.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const a = growIn ? alpha * Math.min(1, 0.25 + i * 0.25) : alpha;
      this.vertex(p.x - dz * h, p.y, p.z + dx * h, color, p.rem, dash, a);
      this.vertex(p.x + dz * h, p.y, p.z - dx * h, color, p.rem, dash, a);
    }
    for (let i = 0; i + 1 < samples.length; i++) {
      const v = base + i * 2;
      this.tri(v, v + 1, v + 2);
      this.tri(v + 1, v + 3, v + 2);
    }
  }

  private ring(r: Ring, alpha: number, width: number): void {
    this.reserve((RING_SEGMENTS + 1) * 2, RING_SEGMENTS * 6);
    const base = this.nv;
    const color = COLORS[r.kind];
    for (let k = 0; k <= RING_SEGMENTS; k++) {
      const t = (k / RING_SEGMENTS) * Math.PI * 2;
      const cx = Math.cos(t);
      const cz = Math.sin(t);
      this.vertex(r.at.x + cx * (r.radius - width * 0.5), r.ys[k], r.at.z + cz * (r.radius - width * 0.5), color, 0, false, alpha);
      this.vertex(r.at.x + cx * (r.radius + width * 0.5), r.ys[k], r.at.z + cz * (r.radius + width * 0.5), color, 0, false, alpha);
    }
    for (let k = 0; k < RING_SEGMENTS; k++) {
      const v = base + k * 2;
      this.tri(v, v + 1, v + 2);
      this.tri(v + 1, v + 3, v + 2);
    }
  }

  private vertex(x: number, y: number, z: number, c: THREE.Color, rem: number, dash: boolean, a: number): void {
    const o = this.nv * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.col[o] = c.r;
    this.col[o + 1] = c.g;
    this.col[o + 2] = c.b;
    this.line[o] = rem;
    this.line[o + 1] = dash ? 1 : 0;
    this.line[o + 2] = a;
    this.nv++;
  }

  private tri(a: number, b: number, c: number): void {
    this.index[this.ni++] = a;
    this.index[this.ni++] = b;
    this.index[this.ni++] = c;
  }

  private reserve(verts: number, indices: number): void {
    if (this.nv + verts <= this.pos.length / 3 && this.ni + indices <= this.index.length) return;
    this.grow(Math.max(this.pos.length / 3, this.nv + verts) * 2, Math.max(this.index.length, this.ni + indices) * 2);
  }

  private grow(verts: number, indices: number): void {
    const copy = <T extends Float32Array | Uint32Array>(old: T, next: T): T => {
      next.set(old.subarray(0, Math.min(old.length, next.length)));
      return next;
    };
    this.geo.dispose();
    this.pos = copy(this.pos, new Float32Array(verts * 3));
    this.col = copy(this.col, new Float32Array(verts * 3));
    this.line = copy(this.line, new Float32Array(verts * 3));
    this.index = copy(this.index, new Uint32Array(indices));
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('line', new THREE.BufferAttribute(this.line, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
