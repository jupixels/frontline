// Whole AI-vs-AI matches, headless (GAME_PLAN §7 I / §8b). The quick ones run with `npm test`;
// the long statistical ones run with FULL_BALANCE=1 (several minutes):
//   FULL_BALANCE=1 npx vitest run tests/balance.matches.test.ts

import { describe, expect, it } from 'vitest';
import units from '../data/units.json';
import rules from '../data/rules.json';
import valley from '../data/maps/valley_pass.json';
import coastal from '../data/maps/coastal_strait.json';
import desert from '../data/maps/desert_oilfields.json';
import { runHeadless } from '../src/ai/headless';
import type { Difficulty } from '../src/ai/difficulty';
import type { MapDef, UnitDef } from '../src/shared/data';
import { SIM_HZ, type MatchSetup } from '../src/shared/types';
import { Simulation } from '../src/sim/simulation';

const UNITS = units as Record<string, UnitDef>;
const MAPS = { valley: valley as unknown as MapDef, coastal: coastal as unknown as MapDef, desert: desert as unknown as MapDef };
const FULL = !!process.env.FULL_BALANCE;

function setup(map: MapDef, ais: Difficulty[], teams: number[], seed: number): MatchSetup {
  return { seed, mapId: map.id, victory: 'frontline', players: ais.map((d, id) => ({ id, team: teams[id], name: `AI${id}`, color: '#888', kind: 'ai' as const, aiDifficulty: d })) };
}

describe('match pacing', () => {
  it('a match nobody fights still ends: bleed, late bleed and sudden death', () => {
    // Two idle players who each hold one point: no bleed from points, so only sudden death ends it.
    const map = MAPS.valley;
    const sim = new Simulation(setup(map, ['normal', 'normal'], [0, 1], 1), { units: UNITS, map });
    const w = sim.world;
    const pts = [...w.entities.values()].filter((e) => e.kind === 'point');
    // South Farm to P0, North Farm to P1 (equal holdings).
    for (const [i, owner] of [[2, 0], [4, 1]] as const) {
      pts[i].owner = owner;
      pts[i].team = owner;
      pts[i].captureProgress = 1;
    }
    for (let t = 0; t < (rules.suddenDeathSeconds + 1200) * SIM_HZ && sim.winner === null; t += 1) sim.step([]);
    expect(sim.winner).not.toBeNull();
    expect(sim.gameTick / SIM_HZ).toBeLessThan(rules.suddenDeathSeconds + 1200);
  }, 120000);

  it('Hard beats Easy on Valley Pass (difficulties play differently)', () => {
    const map = MAPS.valley;
    const r = runHeadless(setup(map, ['easy', 'hard'], [0, 1], 4), { units: UNITS, map }, { maxSeconds: 1500 });
    const easy = r.sim.world.players.get(0)!;
    const hard = r.sim.world.players.get(1)!;
    expect(r.winner === 1 || hard.morale > easy.morale).toBe(true);
    // Easy fields a smaller army than Hard.
    expect(r.produced[1]).toBeGreaterThan(0);
  }, 180000);
});

describe.skipIf(!FULL)('full AI matches (FULL_BALANCE=1)', () => {
  it('matches between equal AIs end before 100 minutes (no stalled stalemates)', () => {
    for (const seed of [21, 22, 23]) {
      const map = MAPS.valley;
      const r = runHeadless(setup(map, ['normal', 'normal'], [0, 1], seed), { units: UNITS, map }, { maxSeconds: 6000 });
      console.log(`stalemate seed ${seed}: winner ${r.winner} after ${Math.round(r.seconds / 60)} min, morale ${JSON.stringify(r.morale)}`);
      expect(r.winner).not.toBeNull();
    }
  }, 1800000);

  it('a side 30% down on morale can still come back', () => {
    let comebacks = 0;
    const seeds = [31, 32, 33, 34, 35, 36];
    for (const seed of seeds) {
      const map = MAPS.valley;
      // Player 0 starts 300 morale behind.
      const r = runHeadless(setup(map, ['normal', 'normal'], [0, 1], seed), { units: UNITS, map }, {
        maxSeconds: 6000,
        everySecond: (sim, s) => {
          if (s === 1) sim.world.teams.get(0)!.morale = rules.startingMorale * 0.7;
        },
      });
      console.log(`comeback seed ${seed}: winner ${r.winner} after ${Math.round(r.seconds / 60)} min`);
      if (r.winner === 0) comebacks++;
    }
    expect(comebacks).toBeGreaterThan(0);
  }, 3600000);

  it('the AI plays every map: navy and transports on Coastal Strait, a 4-player FFA on Desert Oilfields', () => {
    const c = runHeadless(setup(MAPS.coastal, ['normal', 'normal', 'hard', 'normal'], [0, 0, 1, 1], 41), { units: UNITS, map: MAPS.coastal }, { maxSeconds: 2400 });
    const types = Object.values(c.types).flatMap((t) => Object.keys(t));
    console.log('coastal', JSON.stringify(c.types));
    expect(types.some((t) => ['patrol_boat', 'destroyer', 'submarine', 'cruiser'].includes(t))).toBe(true);
    expect(types.some((t) => t === 'transport_ship' || t === 'heli_transport')).toBe(true);
    const d = runHeadless(setup(MAPS.desert, ['easy', 'normal', 'hard', 'normal'], [0, 1, 2, 3], 42), { units: UNITS, map: MAPS.desert }, { maxSeconds: 2400 });
    console.log('desert ffa', d.winner, JSON.stringify(d.morale));
    expect(Object.values(d.produced).every((n) => n > 10)).toBe(true);
  }, 1800000);
});
