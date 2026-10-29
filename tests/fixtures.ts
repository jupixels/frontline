import units from '../data/units.json';
import sandbox from '../data/maps/sandbox.json';
import type { MapDef, UnitDef } from '../src/shared/data';
import type { SimContent } from '../src/sim/world';

export function testContent(): SimContent {
  return { units: units as Record<string, UnitDef>, map: sandbox as MapDef };
}
