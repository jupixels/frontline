import units from '../../data/units.json';
import structures from '../../data/structures.json';
import sandbox from '../../data/maps/sandbox.json';
import type { MapDef, UnitDef } from '../shared/data';
import type { SimContent } from '../sim/world';
import { mapInfoFromDef, type MapInfo, type StructureInfo } from '../ui';

export const UNITS = units as Record<string, UnitDef>;

/** Maps offered in lobbies. Phase 2 adds Valley Pass, Coastal Strait and Desert Oilfields. */
const MAP_DEFS: { def: MapDef; description: string }[] = [
  { def: sandbox as MapDef, description: 'Proving ground. Four corner spawns, capture points in the middle.' },
];

export const MAPS: MapInfo[] = MAP_DEFS.map((m) => mapInfoFromDef(m.def, m.description));

export function mapDef(id: string): MapDef {
  return (MAP_DEFS.find((m) => m.def.id === id) ?? MAP_DEFS[0]).def;
}

/** Sim content for a map. Weapons, structures, abilities and rules default to data/. */
export function simContent(mapId: string): SimContent {
  return { units: UNITS, map: mapDef(mapId) };
}

interface StructureJson {
  name: string;
  cost: number;
  buildSeconds: number;
  footprint: [number, number];
  power: number;
  produces?: string[];
}

/** data/structures.json in the shape the HUD uses. */
export const STRUCTURES: Record<string, StructureInfo> = Object.fromEntries(
  Object.entries(structures as unknown as Record<string, StructureJson>).map(([id, s]) => [
    id,
    {
      id,
      name: s.name,
      cost: s.cost,
      buildSeconds: s.buildSeconds,
      footprint: Math.max(s.footprint[0], s.footprint[1]) / 2,
      power: s.power,
      produces: s.produces ?? [],
    },
  ]),
);
