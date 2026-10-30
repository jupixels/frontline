// Shapes of the JSON balance/content files in data/. Owned by the sim session; shared so render/ui can read them.

import type { MapShape, TerrainDef } from './terrain';
import type { Vec2 } from './types';

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

/** A capture point. `name` shows on the HUD; `radius` defaults to rules.pointRadius. */
export interface MapPoint {
  x: number;
  z: number;
  radius?: number;
  name?: string;
}

/** A map-placed structure, e.g. a neutral ruin infantry can garrison. */
export interface MapStructure {
  type: string;
  x: number;
  z: number;
  /** Radians, snapped to 90 degrees. */
  rotation?: number;
}

/** Render-only decoration (no gameplay): `model` is a path under public/assets/. */
export interface MapProp {
  model: string;
  x: number;
  z: number;
  rotation?: number;
  scale?: number;
}

/** Scatter `models` randomly inside `area` (render only). */
export interface MapPropScatter {
  models: string[];
  area: MapShape;
  count: number;
  scale?: [number, number];
}

export interface MapDef {
  id: string;
  name: string;
  /** Square map, side length in meters. Origin is the map center. */
  size: number;
  /** One per player slot; maps declare how many players they support. */
  spawns: MapSpawn[];
  /**
   * Spawn indices per side for team games, e.g. [[0, 2], [1, 3]]: the first team gets side 0. Free-for-all
   * (or more teams than sides) uses the spawns in order.
   */
  sides?: number[][];
  /** Player counts the map is laid out for, e.g. ['1v1', '2v2', 'ffa4']. Shown in the lobby. */
  modes?: string[];
  /** Ground shape, water, forests, roads and bridges (src/shared/terrain.ts). Omitted = flat. */
  terrain?: TerrainDef;
  points?: MapPoint[];
  /** Supply depots built near one earn more. */
  supplyNodes?: Vec2[];
  structures?: MapStructure[];
  props?: MapProp[];
  scatter?: MapPropScatter[];
  /** Time of day / weather preset for the renderer ('golden', 'overcast', 'noon', 'dusk'). */
  atmosphere?: string;
  /** Legacy (Phase 1): naval-only water and impassable rocks. New maps use `terrain`. */
  water?: MapShape[];
  obstacles?: MapShape[];
}
