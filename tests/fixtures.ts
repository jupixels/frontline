import units from '../data/units.json';
import sandbox from '../data/maps/sandbox.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import type { MatchSetup, VictoryMode } from '../src/shared/types';
import type { SimContent } from '../src/sim/world';

export function testContent(): SimContent {
  return { units: units as Record<string, UnitDef>, map: sandbox as MapDef };
}

/** Content on an open map with no terrain, for focused system tests. */
export function flatContent(): SimContent {
  return { units: units as Record<string, UnitDef>, map: { id: 'flat', name: 'Flat', size: 600, spawns: sandbox.spawns } as MapDef };
}

export function setupFor(teams: number[], victory: VictoryMode = 'frontline', seed = 1234): MatchSetup {
  return {
    seed,
    mapId: 'sandbox',
    victory,
    players: teams.map((team, id) => ({ id, team, name: `P${id}`, color: '#888', kind: 'human' as const })),
  };
}

export function twoPlayers(victory: VictoryMode = 'frontline'): MatchSetup {
  return setupFor([0, 1], victory);
}
