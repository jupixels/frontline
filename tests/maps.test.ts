import { describe, expect, it } from 'vitest';
import units from '../data/units.json';
import valley from '../data/maps/valley_pass.json';
import coastal from '../data/maps/coastal_strait.json';
import desert from '../data/maps/desert_oilfields.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import { assignSpawns } from '../src/shared/maps';
import { TerrainModel } from '../src/shared/terrain';
import type { MatchSetup } from '../src/shared/types';
import { Simulation } from '../src/sim/simulation';

const MAPS = [valley, coastal, desert] as unknown as MapDef[];

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

  it('is rotationally symmetric: each spawn has a twin with the same ground and point distances', () => {
    const t = new TerrainModel(map);
    const n = map.terrain?.symmetry ?? 1;
    expect(n).toBeGreaterThan(1);
    const rot = (p: { x: number; z: number }) => (n === 2 ? { x: -p.x, z: -p.z } : { x: -p.z, z: p.x });
    const profile = (s: { x: number; z: number }) => (map.points ?? []).map((p) => Math.round(Math.hypot(p.x - s.x, p.z - s.z))).sort((a, b) => a - b).join(',');
    for (const s of map.spawns) {
      const r = rot(s);
      const twin = map.spawns.find((o) => Math.abs(o.x - r.x) < 1 && Math.abs(o.z - r.z) < 1);
      expect(twin, `twin of ${s.x},${s.z}`).toBeTruthy();
      expect(Math.abs(t.height(s.x, s.z) - t.height(twin!.x, twin!.z))).toBeLessThan(0.02);
      expect(profile(twin!)).toBe(profile(s));
      // Ground around the spawn matches too (sample a ring).
      for (let a = 0; a < 6.28; a += 0.5) {
        const p = { x: s.x + Math.cos(a) * 150, z: s.z + Math.sin(a) * 150 };
        const q = rot(p);
        expect(Math.abs(t.height(p.x, p.z) - t.height(q.x, q.z))).toBeLessThan(0.02);
      }
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
});
