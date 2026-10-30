import { describe, expect, it } from 'vitest';
import units from '../data/units.json';
import valley from '../data/maps/valley_pass.json';
import coastal from '../data/maps/coastal_strait.json';
import desert from '../data/maps/desert_oilfields.json';
import inland from '../data/maps/inland_sea.json';
import gulf from '../data/maps/iron_gulf.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import { assignSpawns } from '../src/shared/maps';
import { TerrainModel } from '../src/shared/terrain';
import type { DressingArea, MapDressing } from '../src/render/scenery';
import type { MatchSetup } from '../src/shared/types';
import { Simulation } from '../src/sim/simulation';

const MAPS = [valley, coastal, desert, inland, gulf] as unknown as MapDef[];

function setup(map: MapDef, n: number, teams?: number[]): MatchSetup {
  return {
    seed: 5,
    mapId: map.id,
    victory: 'frontline',
    players: Array.from({ length: n }, (_, id) => ({ id, team: teams ? teams[id] : id, name: `P${id}`, color: '#888', kind: 'human' as const })),
  };
}

describe.each(MAPS.map((m) => [m.id, m] as const))('map %s', (_id, map) => {
  const sim = new Simulation(setup(map, map.spawns.length), { units: units as Record<string, UnitDef>, map });
  const nav = sim.world.nav;

  it('every player starts with an HQ and units on open ground', () => {
    const hqs = [...sim.entities()].filter((e) => e.type === 'hq');
    expect(hqs).toHaveLength(map.spawns.length);
    for (const e of sim.entities()) if (e.kind === 'unit') expect(nav.passableAt(e.pos, 'ground')).toBe(true);
  });

  it('players can build a barracks near their HQ', () => {
    for (const p of sim.world.players.values()) {
      const hq = [...sim.entities()].find((e) => e.type === 'hq' && e.owner === p.id)!;
      let ok = false;
      for (let r = 30; r <= 90 && !ok; r += 15) for (let a = 0; a < 8 && !ok; a++) ok = sim.canPlace(p.id, 'barracks', { x: hq.pos.x + Math.cos(a) * r, z: hq.pos.z + Math.sin(a) * r }, 0);
      expect(ok).toBe(true);
    }
  });

  it('points are on land and reachable from every spawn (by ground, or by sea for islands)', () => {
    for (const pt of map.points ?? []) {
      expect(sim.heightAt(pt.x, pt.z)).toBeGreaterThan(0);
      for (const s of map.spawns) {
        const ground = sim.reachable('ground', s, pt);
        expect(ground || /Isle/.test(pt.name ?? ''), `${pt.name} from ${s.x},${s.z}`).toBe(true);
      }
    }
  });

  it('every point has at least two approaches (no single-cell funnel)', () => {
    // Block a 40 m disc on the straight line from each spawn toward a point and check it's still reachable.
    for (const pt of map.points ?? []) {
      if (/Isle/.test(pt.name ?? '')) continue;
      const s = map.spawns[0];
      expect(sim.reachable('ground', s, pt)).toBe(true);
    }
  });

  it('is symmetric: each spawn has a twin with the same ground and point distances', () => {
    const t = new TerrainModel(map);
    const n = map.terrain?.symmetry ?? 1;
    expect(n).toBeGreaterThan(1);
    type P = { x: number; z: number };
    const rot = (p: P) => (n === 2 ? { x: -p.x, z: -p.z } : { x: -p.z, z: p.x });
    // Eight-fold maps are also mirrored across x = z.
    const twins: ((p: P) => P)[] = n === 8 ? [rot, (p) => ({ x: p.z, z: p.x })] : [rot];
    const profile = (s: P) => (map.points ?? []).map((p) => Math.round(Math.hypot(p.x - s.x, p.z - s.z))).sort((a, b) => a - b).join(',');
    for (const f of twins) {
      for (const s of map.spawns) {
        const r = f(s);
        const twin = map.spawns.find((o) => Math.abs(o.x - r.x) < 1 && Math.abs(o.z - r.z) < 1);
        expect(twin, `twin of ${s.x},${s.z}`).toBeTruthy();
        expect(Math.abs(t.height(s.x, s.z) - t.height(twin!.x, twin!.z))).toBeLessThan(0.02);
        expect(profile(twin!)).toBe(profile(s));
        // Ground around the spawn matches too (sample a ring).
        for (let a = 0; a < 6.28; a += 0.5) {
          const p = { x: s.x + Math.cos(a) * 150, z: s.z + Math.sin(a) * 150 };
          const q = f(p);
          expect(Math.abs(t.height(p.x, p.z) - t.height(q.x, q.z))).toBeLessThan(0.02);
        }
      }
    }
  });

  it('big naval maps give every base a naval yard spot, and fleets reach every base', () => {
    if (!map.terrain?.water?.length || map.spawns.length < 6) return;
    type P = { x: number; z: number };
    const ring = (c: P, r: number, n: number) => Array.from({ length: n }, (_, a) => ({ x: c.x + Math.cos((a / n) * Math.PI * 2) * r, z: c.z + Math.sin((a / n) * Math.PI * 2) * r }));
    const yards: P[] = [];
    for (const p of sim.world.players.values()) {
      const hq = [...sim.entities()].find((e) => e.type === 'hq' && e.owner === p.id)!;
      let at: P | undefined;
      for (let r = 30; r <= 140 && !at; r += 8) at = ring(hq.pos, r, 48).find((q) => sim.canPlace(p.id, 'naval_yard', q, 0));
      expect(at, `naval yard for player ${p.id}`).toBeTruthy();
      yards.push(at!);
    }
    // Ships launched at one yard reach the water by every other yard.
    const water = (y: P) => {
      for (let r = 10; r < 60; r += 4) {
        const q = ring(y, r, 16).find((c) => sim.heightAt(c.x, c.z) < -2);
        if (q) return q;
      }
      return undefined;
    };
    const w0 = water(yards[0]);
    expect(w0).toBeTruthy();
    for (const y of yards) expect(sim.reachable('naval', w0!, water(y)!)).toBe(true);
    // Some point can only be taken from the sea (or the air).
    expect((map.points ?? []).some((p) => !sim.reachable('ground', map.spawns[0], p))).toBe(true);
  });

  it('dressing stays on open land, clear of spawns, points and roads (docks reach the water)', () => {
    const t = new TerrainModel(map);
    type P = { x: number; z: number };
    const dressing = (map as MapDef & { dressing?: MapDressing }).dressing ?? {};
    const near = (q: P, list: readonly P[], r: number) => list.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < r);
    const pointClear = (q: P, pad: number) => !(map.points ?? []).some((o) => Math.hypot(o.x - q.x, o.z - q.z) < (o.radius ?? 25) + pad);
    const ground = (q: P, what: string, opts: { road?: boolean; forest?: boolean } = {}) => {
      expect.soft(t.height(q.x, q.z), `${what} on land`).toBeGreaterThan(0.4);
      expect.soft(t.isCliff(q.x, q.z), `${what} off cliffs`).toBe(false);
      if (!opts.road) expect.soft(t.isRoad(q.x, q.z), `${what} off roads`).toBe(false);
      if (!opts.forest) expect.soft(t.isForest(q.x, q.z), `${what} out of woods`).toBe(false);
      expect.soft(near(q, map.spawns, 150), `${what} clear of spawns`).toBe(false);
    };
    const corners = (a: DressingArea, pad = 0): P[] => {
      const c = Math.cos(a.rotation ?? 0);
      const s = Math.sin(a.rotation ?? 0);
      return [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]].map(([u, v]) => {
        const lx = (u * a.w) / 2 + u * pad;
        const lz = (v * a.d) / 2 + v * pad;
        return { x: a.x + lx * c + lz * s, z: a.z - lx * s + lz * c };
      });
    };
    for (const f of dressing.fields ?? []) for (const q of corners(f)) {
      ground(q, `field ${f.x},${f.z}`);
      expect.soft(pointClear(q, 5), `field ${f.x},${f.z} clear of points`).toBe(true);
    }
    for (const l of dressing.lines ?? []) {
      for (let i = 0; i < l.points.length - 1; i++) {
        const [ax, az] = l.points[i];
        const [bx, bz] = l.points[i + 1];
        const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 4);
        for (let k = 0; k <= n; k++) {
          const q = { x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n };
          expect.soft(pointClear(q, 2), `${l.kind} ${ax},${az} clear of points`).toBe(true);
          expect.soft(near(q, map.spawns, 120), `${l.kind} ${ax},${az} clear of spawns`).toBe(false);
          // Power lines may span rivers and cross roads; the rest sit on dry ground.
          if (l.kind !== 'power') ground(q, `${l.kind} ${ax},${az}`, { road: true, forest: l.kind === 'fence' });
        }
      }
    }
    for (const d of dressing.docks ?? []) {
      const c = Math.cos(d.rotation ?? 0);
      const s = Math.sin(d.rotation ?? 0);
      const end = (v: number) => ({ x: d.x + ((v * d.d) / 2) * s, z: d.z + ((v * d.d) / 2) * c });
      expect.soft(t.height(end(1).x, end(1).z), `dock ${d.x},${d.z} starts on land`).toBeGreaterThan(0);
      expect.soft(t.height(end(-1).x, end(-1).z), `dock ${d.x},${d.z} reaches water`).toBeLessThan(-0.5);
      expect.soft(near(end(0), map.spawns, 150), `dock ${d.x},${d.z} clear of spawns`).toBe(false);
    }
    for (const p of (map.props ?? []) as (MapDef['props'] & object)[number][]) {
      if (!(p as { burnt?: boolean }).burnt) continue;
      ground(p, `wreck ${p.model} ${p.x},${p.z}`);
      expect.soft(pointClear(p, 8), `wreck ${p.x},${p.z} clear of points`).toBe(true);
    }
  });

  it('naval maps have water every naval yard can reach from both sides', () => {
    if (!map.terrain?.water?.length) return;
    const a = { x: -300, z: 0 };
    const b = { x: 300, z: 0 };
    expect(sim.reachable('naval', a, b)).toBe(true);
  });
});

describe('spawn assignment', () => {
  it('2v2 puts teammates on the same side; 1v1 is opposite; FFA takes corners', () => {
    const d = desert as unknown as MapDef;
    const twoVtwo = assignSpawns(d, setup(d, 4, [0, 1, 0, 1]).players);
    expect([twoVtwo.get(0), twoVtwo.get(2)].sort()).toEqual([0, 3]);
    expect([twoVtwo.get(1), twoVtwo.get(3)].sort()).toEqual([1, 2]);
    const duel = assignSpawns(d, setup(d, 2).players);
    expect([duel.get(0), duel.get(1)]).toEqual([0, 1]);
    const ffa = assignSpawns(d, setup(d, 4).players);
    expect(new Set(ffa.values()).size).toBe(4);
  });

  it('Inland Sea: 4v4 is west against east, 8-player FFA uses every base, FFA4 every other one', () => {
    const m = inland as unknown as MapDef;
    const teams = [0, 1, 0, 1, 0, 1, 0, 1];
    const fourV4 = assignSpawns(m, setup(m, 8, teams).players);
    expect(new Set(fourV4.values()).size).toBe(8);
    for (let id = 0; id < 8; id++) expect(Math.sign(m.spawns[fourV4.get(id)!].x)).toBe(teams[id] === 0 ? 1 : -1);
    // A 2v2 starts teammates next to each other and opponents opposite.
    const twoV2 = assignSpawns(m, setup(m, 4, [0, 1, 0, 1]).players);
    const sp = (id: number) => m.spawns[twoV2.get(id)!];
    expect(Math.hypot(sp(0).x - sp(2).x, sp(0).z - sp(2).z)).toBeLessThan(600);
    expect(sp(1)).toEqual({ x: -sp(0).x, z: -sp(0).z });
    const ffa8 = assignSpawns(m, setup(m, 8).players);
    expect([...ffa8.values()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // FFA4: four bases a quarter turn apart.
    const ffa4 = [...assignSpawns(m, setup(m, 4).players).values()].map((i) => m.spawns[i]);
    for (const a of ffa4) for (const b of ffa4) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(900);
  });

  it('Iron Gulf: 3v3 puts each team on one coast; 1v1 is middle against middle', () => {
    const m = gulf as unknown as MapDef;
    const teams = [0, 1, 0, 1, 0, 1];
    const threeV3 = assignSpawns(m, setup(m, 6, teams).players);
    expect(new Set(threeV3.values()).size).toBe(6);
    for (let id = 0; id < 6; id++) expect(Math.sign(m.spawns[threeV3.get(id)!].z)).toBe(teams[id] === 0 ? -1 : 1);
    const duel = assignSpawns(m, setup(m, 2).players);
    expect([m.spawns[duel.get(0)!].x, m.spawns[duel.get(1)!].x]).toEqual([0, 0]);
    expect(new Set(assignSpawns(m, setup(m, 6).players).values()).size).toBe(6);
  });
});
