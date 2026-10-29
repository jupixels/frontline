// Shapes of the JSON balance/content files in data/. Owned by the sim session; shared so render/ui can read them.

export type ArmorClass = 'infantry' | 'light' | 'heavy' | 'air' | 'naval' | 'structure';
export type Domain = 'ground' | 'air' | 'naval';

export interface UnitDef {
  name: string;
  /** Path under public/assets/, e.g. "models/tank_mbt.glb". Scaled to meters by the asset pipeline. */
  model: string;
  domain: Domain;
  armor: ArmorClass;
  hp: number;
  /** Meters per second. */
  speed: number;
  /** Radians per second. */
  turnRate: number;
  /** Collision/selection radius in meters. */
  radius: number;
  /** Fog-of-war vision range in meters. */
  sight: number;
  cost: number;
  buildSeconds: number;
  /** Optional turret node name in the model (render aims it). */
  turretNode?: string;
  /** Radians per second for the turret. */
  turretTurnRate?: number;
}

export interface MapSpawn {
  x: number;
  z: number;
}

export interface MapDef {
  id: string;
  name: string;
  /** Square map, side length in meters. Origin is the map center. */
  size: number;
  /** One per player slot; maps declare how many players they support. */
  spawns: MapSpawn[];
}
