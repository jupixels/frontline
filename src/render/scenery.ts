import * as THREE from 'three';
import type { MapDef, MapProp } from '../shared/data';
import { DEEP_WATER, shapeBounds, shapeDistance, type MapShape, type TerrainModel } from '../shared/terrain';
import { loadModel } from './models';
import type { QualityLevel } from './quality';

/** Tree mixes per terrain style. */
const TREES: Record<string, string[]> = {
  temperate: ['models/env/tree_oak.glb', 'models/env/tree_detailed.glb', 'models/env/tree_default.glb', 'models/env/tree_fat.glb', 'models/env/tree_pine_round.glb'],
  coastal: ['models/env/tree_pine_tall.glb', 'models/env/tree_pine_round.glb', 'models/env/tree_pine_small.glb', 'models/env/tree_default.glb'],
  desert: ['models/env/tree_default.glb', 'models/env/tree_fat.glb', 'models/env/bush_large.glb', 'models/env/bush_detailed.glb'],
};
const UNDERGROWTH = ['models/env/bush_small.glb', 'models/env/bush_large.glb', 'models/env/tree_stump.glb'];

/**
 * Render-only map dressing (`dressing` in data/maps/*.json, written by tools/make-maps.mjs). The sim
 * never reads it: nothing here blocks movement or gives cover. Shared-contract proposal: promote to
 * `MapDef.dressing` (and `burnt` to `MapProp`).
 */
export interface MapDressing {
  lines?: DressingLine[];
  fields?: DressingArea[];
  docks?: DressingArea[];
}
export interface DressingLine {
  /** Wooden fence, dry-stone wall, power line on poles, or a raised pipeline. */
  kind: 'fence' | 'wall' | 'power' | 'pipe';
  points: [number, number][];
}
/** Rectangle `w` (local x) by `d` (local z) centered on (x, z), turned by `rotation` (radians, like props). */
export interface DressingArea {
  x: number;
  z: number;
  w: number;
  d: number;
  rotation?: number;
  crop?: 'wheat' | 'green' | 'furrow';
}
/** A prop drawn charred (burnt-out wrecks reuse the unit models). */
type DressedProp = MapProp & { burnt?: boolean };
/**
 * How a model is recolored: charred for wrecks; on desert maps the Kenney rocks lose their green
 * tops (sand and sandstone) and bushes turn to dry scrub.
 */
type Look = 'burnt' | 'desert';
const DESERT_ROCK: Record<string, number> = { grass: 0xc4a878, dirt: 0x9a8064 };
const DESERT_SCRUB: Record<string, number> = { grass: 0x857a4c };

/** Camera distance (zoom) beyond which small props are hidden, by quality: from up high they're specks. */
const DETAIL_ZOOM: Record<QualityLevel, number> = { low: 150, medium: 230, high: 320, ultra: Infinity };
/** Share of scattered rocks and bushes kept, by quality. */
const SCATTER_SHARE: Record<QualityLevel, number> = { low: 0.45, medium: 0.75, high: 1, ultra: 1 };
/** Props smaller than this (largest side, meters) count as small detail: sandbag walls and barriers included. */
const SMALL = 4.5;

/** Meshy power pole (models/catalog.json): crossarm along x, wires hang from its insulators. */
const POWER_POLE = 'models/buildings/props/power_pole.glb';
const WIRE_OFFSETS = [-2, 0, 2];
const WIRE_HEIGHT = 8.4;
/** Meshy pier section: `length` along x, deck `height` above its base; `deck` is where the deck sits. */
const PIER = { model: 'models/buildings/props/pier.glb', length: 16, width: 4.42, height: 2.96, deck: 1.6 };

const ROAD_COLORS: Record<string, [number, number]> = {
  temperate: [0x8c7a5c, 0x6f5f47],
  coastal: [0x6a6862, 0x55534e],
  desert: [0xb8a07a, 0x9a8462],
};
const CROPS: Record<string, [number, number]> = {
  wheat: [0xab9356, 0x948048],
  green: [0x5b7142, 0x4b5f37],
  furrow: [0x66523d, 0x544331],
};

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
  look?: Look;
}

/** A procedural part (post, rail, pole, pipe…): one shared geometry, many matrices. */
interface Primitive {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  small: boolean;
  shadow: boolean;
  matrices: THREE.Matrix4[];
  colors?: THREE.Color[];
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);

/**
 * Static map decoration: trees filling the forests the sim knows about, scattered rocks and bushes,
 * the map's props (sandbags, oil tanks, containers, wrecks), bridge decks, road surfaces and the
 * map's dressing (fences, walls, power lines, pipelines, fields, docks). Everything repeated is
 * instanced, one mesh per model part; small detail hides when the camera zooms out.
 */
export class Scenery {
  readonly group = new THREE.Group();
  private readonly placements = new Map<string, Placement[]>();
  private readonly prims = new Map<string, Primitive>();
  private readonly meshes: THREE.InstancedMesh[] = [];
  /** Small-detail meshes, hidden when zoomed out. */
  private readonly detail: THREE.InstancedMesh[] = [];
  /** Geometry and materials made here (not from the model cache), for dispose. */
  private readonly owned: { dispose(): void }[] = [];
  private detailZoom: number;
  private detailShown = true;
  /** Recolored copies of model materials, by look and source material. */
  private readonly looks = new Map<string, Map<THREE.Material, THREE.Material>>();
  /** Fields and docks, kept clear of scattered rocks and bushes. */
  private readonly areas: DressingArea[] = [];

  constructor(
    private readonly map: MapDef,
    private readonly terrain: TerrainModel,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly quality: QualityLevel,
  ) {
    this.group.name = 'scenery';
    this.detailZoom = DETAIL_ZOOM[quality];
    const style = terrain.style;
    const r = rng(terrain.def.seed + 101);
    this.plantForests(TREES[style] ?? TREES.temperate, r);
    const dressing = (map as MapDef & { dressing?: MapDressing }).dressing;
    this.areas.push(...(dressing?.fields ?? []), ...(dressing?.docks ?? []));
    const share = SCATTER_SHARE[quality];
    for (const sc of map.scatter ?? []) this.scatter(sc.models, sc.area, Math.round(sc.count * share), sc.scale ?? [0.8, 1.4], r);
    for (const p of (map.props ?? []) as DressedProp[]) this.add(p.model, { ...this.place(p), look: p.burnt ? 'burnt' : undefined });
    this.buildBridges();
    this.buildRoads(ROAD_COLORS[style] ?? ROAD_COLORS.temperate);
    if (dressing) {
      this.buildFields(dressing.fields ?? []);
      for (const line of dressing.lines ?? []) this.buildLine(line, r);
      for (const dock of dressing.docks ?? []) this.buildDock(dock);
    }
    this.flushPrimitives();
    void this.build();
  }

  /** Scattered rocks and bushes match the sand on desert maps. */
  private get sandy(): Look | undefined {
    return this.terrain.style === 'desert' ? 'desert' : undefined;
  }

  private get shadows(): boolean {
    return this.quality !== 'low';
  }

  private place(p: MapProp): Placement {
    return { x: p.x, y: this.heightAt(p.x, p.z), z: p.z, rot: p.rotation ?? 0, scale: p.scale ?? 1 };
  }

  private add(model: string, p: Placement): void {
    const key = p.look ? `${model}#${p.look}` : model;
    let list = this.placements.get(key);
    if (!list) this.placements.set(key, (list = []));
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
    for (const a of this.areas) {
      const c = Math.cos(a.rotation ?? 0);
      const sn = Math.sin(a.rotation ?? 0);
      const dx = x - a.x;
      const dz = z - a.z;
      // Back into the area's own frame (inverse of the yaw used to place it).
      if (Math.abs(dx * c - dz * sn) < a.w / 2 + 3 && Math.abs(dx * sn + dz * c) < a.d / 2 + 3) return false;
    }
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
          if (r() < 0.3 && this.quality !== 'low') {
            const ux = px + (r() - 0.5) * 4;
            const uz = pz + (r() - 0.5) * 4;
            this.add(UNDERGROWTH[Math.floor(r() * UNDERGROWTH.length)], { x: ux, y: this.heightAt(ux, uz), z: uz, rot: r() * 6.28, scale: 0.7 + r() * 0.6, look: this.sandy });
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
      this.add(model, { x, y: this.heightAt(x, z) - 0.15, z, rot: r() * Math.PI * 2, scale: s0 + r() * (s1 - s0), look: this.sandy });
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

  // --- ground overlays: roads and fields --------------------------------------------------------

  /** Road surfaces draped over the ground along the terrain's road lines (bridges carry their own deck). */
  private buildRoads([center, edge]: [number, number]): void {
    const t = this.terrain;
    if (!t.roads.length) return;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const cc = new THREE.Color(center);
    const ce = new THREE.Color(edge);
    for (const road of t.roads) {
      const half = (road.width ?? 7) / 2;
      // Sample the polyline every few meters; a cross-section is edge, center, edge.
      const samples: [number, number, number, number][] = [];
      for (let i = 0; i < road.points.length - 1; i++) {
        const [ax, az] = road.points[i];
        const [bx, bz] = road.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len / 4));
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
          const f = k / n;
          samples.push([ax + (bx - ax) * f, az + (bz - az) * f, (bx - ax) / len, (bz - az) / len]);
        }
      }
      let prevRow = -1;
      for (const [x, z, dx, dz] of samples) {
        // Over water the bridge deck is the road.
        if (t.height(x, z) < 0.3 || (t.bridges.length && t.bridgeDeck(x, z) !== null)) {
          prevRow = -1;
          continue;
        }
        const row = pos.length / 3;
        const nx = -dz;
        const nz = dx;
        for (const [o, c] of [[-half, ce], [0, cc], [half, ce]] as const) {
          const px = x + nx * o;
          const pz = z + nz * o;
          pos.push(px, this.heightAt(px, pz) + 0.12, pz);
          col.push(c.r, c.g, c.b);
        }
        if (prevRow >= 0) {
          for (let k = 0; k < 2; k++) {
            const a = prevRow + k;
            const b = row + k;
            // Counter-clockwise seen from above, so the strip faces up.
            idx.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
        prevRow = row;
      }
    }
    if (!idx.length) return;
    this.addOverlay(pos, col, idx, 'roads', -2);
  }

  /** Crop rows in each field, draped over the ground. */
  private buildFields(fields: DressingArea[]): void {
    if (!fields.length) return;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const cell = 3;
    const ca = new THREE.Color();
    const cb = new THREE.Color();
    const c = new THREE.Color();
    for (const f of fields) {
      const [a, b] = CROPS[f.crop ?? 'wheat'] ?? CROPS.wheat;
      ca.setHex(a);
      cb.setHex(b);
      const rot = f.rotation ?? 0;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const nx = Math.max(1, Math.round(f.w / cell));
      const nz = Math.max(1, Math.round(f.d / cell));
      const base = pos.length / 3;
      for (let j = 0; j <= nz; j++) {
        for (let i = 0; i <= nx; i++) {
          const lx = (i / nx - 0.5) * f.w;
          const lz = (j / nz - 0.5) * f.d;
          // Same convention as prop rotation (yaw about +y).
          const x = f.x + lx * cos + lz * sin;
          const z = f.z - lx * sin + lz * cos;
          pos.push(x, this.heightAt(x, z) + 0.08, z);
          // Rows run along local z: alternate colors across local x, each row a little uneven.
          c.copy(i % 2 === 0 ? ca : cb).multiplyScalar(0.92 + ((i * 7919 + j * 104729) % 97) / 600);
          col.push(c.r, c.g, c.b);
        }
      }
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const v = base + j * (nx + 1) + i;
          idx.push(v, v + nx + 1, v + 1, v + 1, v + nx + 1, v + nx + 2);
        }
      }
    }
    this.addOverlay(pos, col, idx, 'fields', -1);
  }

  private addOverlay(pos: number[], col: number[], idx: number[], name: string, offset: number): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
    const mesh = new THREE.Mesh(geo, mat);
    this.owned.push(geo, mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // --- lines: fences, walls, power lines, pipelines ---------------------------------------------

  private prim(key: string, make: () => Omit<Primitive, 'matrices'>): Primitive {
    let p = this.prims.get(key);
    if (!p) {
      this.prims.set(key, (p = { ...make(), matrices: [] }));
      this.owned.push(p.geometry, p.material);
    }
    return p;
  }

  /** Points every `step` meters along a polyline (ends included), with the direction there. */
  private walk(points: [number, number][], step: number, cb: (x: number, z: number, dx: number, dz: number) => void): void {
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const n = Math.max(1, Math.round(len / step));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) cb(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, (bx - ax) / len, (bz - az) / len);
    }
  }

  /** A box (geometry 1x1x1, long side z) stretched between two points `h` above the ground. */
  private beam(p: Primitive, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, hgt: number, color?: THREE.Color): void {
    _v.set(bx - ax, by - ay, bz - az);
    const len = _v.length();
    _q.setFromUnitVectors(Z, _v.normalize());
    p.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q.clone(), _s.set(w, hgt, len).clone()));
    if (color) (p.colors ??= []).push(color);
  }

  private upright(p: Primitive, x: number, y: number, z: number, w: number, hgt: number, d: number, yaw = 0, color?: THREE.Color): void {
    _q.setFromAxisAngle(Y, yaw);
    p.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y + hgt / 2, z), _q.clone(), new THREE.Vector3(w, hgt, d)));
    if (color) (p.colors ??= []).push(color);
  }

  private buildLine(line: DressingLine, r: () => number): void {
    const box = () => new THREE.BoxGeometry(1, 1, 1);
    const pts = line.points;
    if (line.kind === 'fence') {
      const post = this.prim('fence-post', () => ({ geometry: box(), material: new THREE.MeshStandardMaterial({ color: 0x5c4630, roughness: 0.95 }), small: true, shadow: false }));
      const rail = this.prim('fence-rail', () => ({ geometry: box(), material: new THREE.MeshStandardMaterial({ color: 0x7a6043, roughness: 0.95 }), small: true, shadow: false }));
      let prev: [number, number, number] | null = null;
      this.walk(pts, 3, (x, z) => {
        const y = this.heightAt(x, z);
        this.upright(post, x, y - 0.1, z, 0.14, 1.25, 0.14);
        if (prev && this.quality !== 'low') {
          for (const h of [0.5, 0.95]) this.beam(rail, prev[0], prev[1] + h, prev[2], x, y + h, z, 0.06, 0.12);
        }
        prev = [x, y, z];
      });
    } else if (line.kind === 'wall') {
      const stone = this.prim('wall-stone', () => ({ geometry: box(), material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), small: true, shadow: true }));
      let prev: [number, number, number] | null = null;
      this.walk(pts, 2, (x, z) => {
        const y = this.heightAt(x, z);
        // Dry-stone walls: uneven height, the odd gap where it has tumbled down.
        if (prev && r() > 0.08) {
          const hgt = 0.65 + r() * 0.3;
          const g = 0.26 + r() * 0.1;
          this.beam(stone, prev[0], prev[1] + hgt / 2 - 0.1, prev[2], x, y + hgt / 2 - 0.1, z, 0.6, hgt, new THREE.Color(g, g * 0.97, g * 0.92));
        }
        prev = [x, y, z];
      });
    } else if (line.kind === 'power') {
      const wire: number[] = [];
      let prev: { x: number; y: number; z: number; nx: number; nz: number } | null = null;
      this.walk(pts, 40, (x, z, dx, dz) => {
        const y = this.heightAt(x, z);
        // No poles in rivers: the wires span to the next pole on land.
        if (y < 0.5) return;
        // The pole's crossarm is its x axis: face along the line so the arm stands across it.
        this.add(POWER_POLE, { x, y: y - 0.2, z, rot: Math.atan2(dx, dz), scale: 1 });
        const nx = -dz;
        const nz = dx;
        if (prev) {
          // Three sagging wires from the crossarm's insulators.
          for (const o of WIRE_OFFSETS) {
            const ax = prev.x + prev.nx * o;
            const az = prev.z + prev.nz * o;
            const bx = x + nx * o;
            const bz = z + nz * o;
            const ay = prev.y + WIRE_HEIGHT;
            const by = y + WIRE_HEIGHT;
            const n = 8;
            for (let k = 0; k < n; k++) {
              for (const f of [k / n, (k + 1) / n]) {
                const sag = 4 * f * (1 - f) * 1.4;
                wire.push(ax + (bx - ax) * f, ay + (by - ay) * f - sag, az + (bz - az) * f);
              }
            }
          }
        }
        prev = { x, y: y - 0.2, z, nx, nz };
      });
      if (wire.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
        const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1d1b19, transparent: true, opacity: 0.75 }));
        this.owned.push(geo, lines.material);
        lines.name = 'power-wires';
        this.group.add(lines);
      }
    } else if (line.kind === 'pipe') {
      const pipe = this.prim('pipe', () => ({ geometry: new THREE.CylinderGeometry(0.5, 0.5, 1, 10).rotateX(Math.PI / 2), material: new THREE.MeshStandardMaterial({ color: 0x8c7b66, roughness: 0.55, metalness: 0.45 }), small: false, shadow: true }));
      const support = this.prim('pipe-support', () => ({ geometry: box(), material: new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.8 }), small: true, shadow: false }));
      let prev: [number, number, number] | null = null;
      this.walk(pts, 8, (x, z, dx, dz) => {
        const y = this.heightAt(x, z);
        this.upright(support, x, y - 0.3, z, 0.3, 1.3, 1.2, Math.atan2(dx, dz) + Math.PI / 2);
        if (prev) this.beam(pipe, prev[0], prev[1] + 1.4, prev[2], x, y + 1.4, z, 1, 1);
        prev = [x, y, z];
      });
    }
  }

  /** Timber jetty from pier sections laid end to end (and side by side for wide docks), deck just above the water. */
  private buildDock(dock: DressingArea): void {
    const rot = dock.rotation ?? 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const sections = Math.max(1, Math.round(dock.d / PIER.length));
    const scale = dock.d / sections / PIER.length;
    const rows = Math.max(1, Math.round(dock.w / (PIER.width * scale)));
    for (let k = 0; k < sections; k++) {
      for (let j = 0; j < rows; j++) {
        const lz = -dock.d / 2 + ((k + 0.5) * dock.d) / sections;
        const lx = (j - (rows - 1) / 2) * PIER.width * scale;
        const x = dock.x + lx * cos + lz * sin;
        const z = dock.z - lx * sin + lz * cos;
        // The section's long axis is its x: turn it onto the dock's length.
        this.add(PIER.model, { x, y: PIER.deck - PIER.height * scale, z, rot: rot - Math.PI / 2, scale });
      }
    }
  }

  /** Turn the procedural parts into instanced meshes, one per part. */
  private flushPrimitives(): void {
    for (const p of this.prims.values()) {
      if (!p.matrices.length) continue;
      const inst = new THREE.InstancedMesh(p.geometry, p.material, p.matrices.length);
      p.matrices.forEach((m, i) => {
        inst.setMatrixAt(i, m);
        if (p.colors) inst.setColorAt(i, p.colors[i]);
      });
      this.finish(inst, p.small, p.shadow);
    }
    this.prims.clear();
  }

  private finish(inst: THREE.InstancedMesh, small: boolean, shadow: boolean): void {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.castShadow = shadow && this.shadows;
    inst.receiveShadow = true;
    inst.userData.shadow = shadow;
    this.meshes.push(inst);
    this.group.add(inst);
    if (!small) return;
    inst.visible = this.detailShown;
    this.detail.push(inst);
  }

  /** Recolored copy of a model material (see `Look`), made once per look and material. */
  private restyle(mat: THREE.Material, look: Look, model: string): THREE.Material {
    let cache = this.looks.get(`${look}:${model}`);
    if (!cache) this.looks.set(`${look}:${model}`, (cache = new Map()));
    let out = cache.get(mat);
    if (out) return out;
    const c = mat.clone() as THREE.MeshStandardMaterial;
    if (look === 'burnt') {
      if (c.color) c.color.lerp(new THREE.Color(0x231f1c), 0.82);
      if ('roughness' in c) c.roughness = 1;
      if ('metalness' in c) c.metalness = 0.15;
      if (c.emissive) c.emissive.setHex(0);
    } else {
      const table = model.includes('/rock_') ? DESERT_ROCK : DESERT_SCRUB;
      const hex = table[mat.name];
      if (hex !== undefined && c.color) c.color.setHex(hex);
    }
    cache.set(mat, (out = c));
    this.owned.push(c);
    return out;
  }

  /** Load each model once and draw all its placements as instanced meshes. */
  private async build(): Promise<void> {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const size = new THREE.Vector3();
    for (const [key, list] of this.placements) {
      const [model, look] = key.split('#') as [string, Look | undefined];
      let prepared;
      try {
        prepared = await loadModel(model);
      } catch {
        continue;
      }
      prepared.scene.updateMatrixWorld(true);
      new THREE.Box3().setFromObject(prepared.scene).getSize(size);
      const small = Math.max(size.x, size.y, size.z) < SMALL;
      prepared.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const local = mesh.matrixWorld.clone();
        const material = !look ? mesh.material : Array.isArray(mesh.material) ? mesh.material.map((x) => this.restyle(x, look, model)) : this.restyle(mesh.material, look, model);
        const inst = new THREE.InstancedMesh(mesh.geometry, material, list.length);
        list.forEach((p, i) => {
          q.setFromAxisAngle(up, p.rot);
          m.compose(pos.set(p.x, p.y, p.z), q, scl.setScalar(p.scale)).multiply(local);
          inst.setMatrixAt(i, m);
        });
        this.finish(inst, small, !small);
      });
    }
  }

  /** Show small detail only when zoomed in closer than the quality's limit. Call once per frame. */
  update(zoomDistance: number): void {
    const show = zoomDistance < this.detailZoom;
    if (show === this.detailShown) return;
    this.detailShown = show;
    for (const m of this.detail) m.visible = show;
  }

  setQuality(level: QualityLevel): void {
    this.detailZoom = DETAIL_ZOOM[level];
    const on = level === 'high' || level === 'ultra';
    for (const m of this.meshes) m.castShadow = on && !!m.userData.shadow;
  }

  dispose(): void {
    // Model geometry/materials belong to the shared model cache; only the instance buffers and what
    // we built here (bridges, overlays, procedural parts, charred materials) are ours.
    for (const m of this.meshes) m.dispose();
    for (const o of this.owned) o.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) mesh.geometry.dispose();
    });
  }
}
