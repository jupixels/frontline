// Sim-side shapes of the data/ JSON files. These extend src/shared/data.ts and are listed as
// shared-contract proposals in the PR; until promoted, other modules import them from here.

import damageJson from '../../data/damage.json';
import rulesJson from '../../data/rules.json';
import structuresJson from '../../data/structures.json';
import weaponsJson from '../../data/weapons.json';
import type { ArmorClass, Domain, MapDef, UnitDef } from '../shared/data';
import type { Vec2 } from '../shared/types';

export type DamageType = 'small_arms' | 'ap' | 'he' | 'aa' | 'torpedo';
/** What a weapon can shoot at. Structures count as 'ground'. */
export type TargetLayer = 'ground' | 'air' | 'naval';

export interface WeaponDef {
  /** Meters. */
  range: number;
  /** Indirect weapons can't fire closer than this. */
  minRange?: number;
  damage: number;
  /** Seconds between shots. */
  reload: number;
  damageType: DamageType;
  /** hitscan: instant. projectile: travels to the target. indirect: lobbed at a point, needs team vision. */
  delivery: 'hitscan' | 'projectile' | 'indirect';
  /** m/s, for projectile/indirect. */
  projectileSpeed?: number;
  /** Splash radius in meters (full damage at the center, half at the edge). */
  splash?: number;
  /** Indirect fire: max random offset from the aim point in meters. */
  scatter?: number;
  targets: TargetLayer[];
  /** turret: aims with turretHeading and can fire on the move. hull: the unit turns to face. */
  mount: 'turret' | 'hull';
  /** Chance a direct shot hits, 0..1. */
  accuracy: number;
}

export interface FacingArmor {
  front: number;
  side: number;
  rear: number;
}

/** Proposed additions to shared UnitDef. */
export interface SimUnitDef extends UnitDef {
  /** Command points per squad. */
  cp: number;
  /** Tech tier 1..3. */
  tier: number;
  weapons: string[];
  /** Soldiers spawned per produced squad (default 1). cost/cp cover the whole squad. */
  squad?: number;
  /** Can construct structures. */
  builder?: boolean;
  /** Directional damage multipliers for vehicles. */
  facing?: FacingArmor;
}

export interface StructureDef {
  name: string;
  /** Path under public/assets/. */
  model: string;
  hp: number;
  /** Width (x) and depth (z) in meters at rotation 0. */
  footprint: [number, number];
  cost: number;
  buildSeconds: number;
  /** Positive = produces power, negative = consumes. */
  power: number;
  sight: number;
  tier: number;
  /** False for the HQ (spawned at match start, never built). */
  buildable?: boolean;
  /** Structure types the player must own (completed) first. */
  requires?: string[];
  /** Unit types this structure can produce. */
  produces?: string[];
  /** Counts as a production building for Annihilation. */
  production?: boolean;
  /** 'shore': must sit on land next to water (naval yard). */
  placement?: 'land' | 'shore';
  /** Supply per second. */
  income?: number;
  /** Owning one unlocks this tier. */
  grantsTier?: number;
  heal?: { radius: number; perSecond: number };
  weapons?: string[];
}

export type DamageTable = Record<DamageType, Record<ArmorClass, number>>;

export interface RulesDef {
  startingSupply: number;
  startingTickets: number;
  baseCp: number;
  cpPerPoint: number;
  cpMax: number;
  /** Supply per second per held point. */
  pointIncome: number;
  supplyNodeRadius: number;
  /** Income multiplier for a supply depot built on a supply node. */
  supplyNodeMult: number;
  captureSeconds: number;
  pointRadius: number;
  /** Tickets per second per point the team is behind the leader. */
  bleedPerPointDiff: number;
  lateBleedSeconds: number;
  lateBleedMult: number;
  unitLossTicketsPerCp: number;
  suddenDeathSeconds: number;
  /** Tickets per second every team loses in sudden death. */
  suddenDeathBleed: number;
  suddenDeathHqDamageMult: number;
  tier3UnlockSeconds: number;
  buildRadius: number;
  lowPowerProductionMult: number;
  maxQueue: number;
  navCellSize: number;
  fogCellSize: number;
  fogUpdateTicks: number;
}

export type MapShape =
  | { shape: 'rect'; x: number; z: number; w: number; d: number }
  | { shape: 'circle'; x: number; z: number; r: number };

/** Proposed additions to shared MapDef. All optional so old maps still load. */
export interface SimMapDef extends MapDef {
  /** Impassable for ground and naval (cliffs, rocks, dense forest). */
  obstacles?: MapShape[];
  /** Water: naval only. */
  water?: MapShape[];
  /** Capture points. */
  points?: (Vec2 & { radius?: number })[];
  /** Supply depots built near one earn more. */
  supplyNodes?: Vec2[];
}

/** What the sim needs. units + map are required (shared contract); the rest default to data/. */
export interface SimContent {
  units: Record<string, UnitDef>;
  map: MapDef;
  weapons?: Record<string, WeaponDef>;
  structures?: Record<string, StructureDef>;
  damage?: DamageTable;
  rules?: RulesDef;
}

export interface ResolvedContent {
  units: Record<string, SimUnitDef>;
  map: SimMapDef;
  weapons: Record<string, WeaponDef>;
  structures: Record<string, StructureDef>;
  damage: DamageTable;
  rules: RulesDef;
}

export function resolveContent(c: SimContent): ResolvedContent {
  const units: Record<string, SimUnitDef> = {};
  for (const id of Object.keys(c.units).sort()) {
    const u = c.units[id] as Partial<SimUnitDef> & UnitDef;
    units[id] = { ...u, cp: u.cp ?? 1, tier: u.tier ?? 1, weapons: u.weapons ?? [] };
  }
  return {
    units,
    map: c.map as SimMapDef,
    weapons: c.weapons ?? (weaponsJson as Record<string, WeaponDef>),
    structures: c.structures ?? (structuresJson as unknown as Record<string, StructureDef>),
    damage: c.damage ?? (damageJson as DamageTable),
    rules: c.rules ?? (rulesJson as RulesDef),
  };
}

export function layerOf(domain: Domain): TargetLayer {
  return domain;
}
