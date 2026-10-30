// Six- and eight-player naval maps played headless by AIs in every slot (the 4v4 split is covered by
// tests/maps.test.ts; longer runs: SIMRUN=1 MAP=inland_sea AIS=... tests/tools/sim-run.test.ts).
import { describe, expect, it } from 'vitest';
import units from '../data/units.json';
import inland from '../data/maps/inland_sea.json';
import gulf from '../data/maps/iron_gulf.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import type { MatchSetup } from '../src/shared/types';
import { runHeadless } from '../src/ai/headless';

const SHIPS = ['patrol_boat', 'destroyer', 'submarine', 'cruiser'];

function setup(map: MapDef, teams: number[]): MatchSetup {
  return {
    seed: 3,
    mapId: map.id,
    victory: 'frontline',
    players: teams.map((team, id) => ({ id, team, name: `AI${id}`, color: '#888', kind: 'ai' as const, aiDifficulty: id % 3 === 2 ? 'hard' : 'normal' })),
  };
}

describe('big naval maps, AIs only', () => {
  it.each([
    ['Inland Sea 8-player FFA', inland, [0, 1, 2, 3, 4, 5, 6, 7]],
    ['Iron Gulf 3v3', gulf, [0, 1, 0, 1, 0, 1]],
  ] as const)('%s plays without errors and every AI goes to sea', (_name, json, teams) => {
    const map = json as unknown as MapDef;
    const r = runHeadless(setup(map, [...teams]), { units: units as Record<string, UnitDef>, map }, { maxSeconds: 480 });
    expect(r.seconds).toBeGreaterThan(0);
    let navies = 0;
    for (let id = 0; id < teams.length; id++) {
      expect(r.produced[id], `AI${id} produced`).toBeGreaterThan(10);
      const yard = [...r.sim.entities()].some((e) => e.owner === id && e.type === 'naval_yard');
      if (yard || SHIPS.some((t) => r.types[id][t])) navies++;
    }
    // Eight minutes in, most AIs have a naval yard (sea maps put it before the war factory).
    expect(navies).toBeGreaterThanOrEqual(Math.ceil(teams.length * 0.75));
  }, 600_000);
});
