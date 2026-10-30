// Sim-side shapes of the data/ JSON files. These extend src/shared/data.ts and are listed as
// shared-contract proposals in the PR; until promoted, other modules import them from here.

import abilitiesJson from '../../data/abilities.json';
import damageJson from '../../data/damage.json';
import rulesJson from '../../data/rules.json';
import structuresJson from '../../data/structures.json';
import weaponsJson from '../../data/weapons.json';
import type { ArmorClass, Domain, MapDef, UnitDef } from '../shared/data';

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
  /** Suppression added to infantry per hit (near misses add a third). Default from damage type. */
  suppression?: number;
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
  /** Ability ids from data/abilities.json. */
  abilities?: string[];
  /** Automatic logistics unit (supply truck): not commandable, doesn't capture. */
  logistics?: boolean;
  /** Carries other units: seats and which armor classes may board. */
  transport?: { seats: number; carries: ArmorClass[] };
  /** Seats this unit takes in a transport (default: infantry 1, light 4, heavy 6). */
  seats?: number;
  /** Submarine: hidden from enemies beyond close range unless it fired recently. */
  submerged?: boolean;
}

/** Active ability. Effect parameters are per ability id; unused ones are omitted. */
export interface AbilityDef {
  name: string;
  /** self: instant on the caster. point/unit: caster moves into `range`, then casts. */
  target: 'self' | 'point' | 'unit';
  /** Meters. 0 = use the caster's longest weapon range. */
  range: number;
  /** Seconds. */
  cooldown: number;
  /** Supply paid by the caster's owner. */
  cost: number;
  radius?: number;
  /** Seconds the effect lasts. */
  duration?: number;
  speedMult?: number;
  deploySeconds?: number;
  packSeconds?: number;
  /** Damage multiplier while entrenched. */
  damageTaken?: number;
  shots?: number;
  /** Seconds between barrage shells. */
  interval?: number;
  /** Target point must be visible to the caster's team. */
  requiresVision?: boolean;
  /** Ambush: enemies closer than this still see the unit. */
  revealRange?: number;
  firstShotMult?: number;
  /** One caster per command (the closest), e.g. smoke. */
  single?: boolean;
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
  /** Infantry seats for garrisoning. Occupants fire out and only the building can be hit. */
  garrison?: number;
  /** Owning one (complete, powered) charges the superweapon. */
  superweapon?: boolean;
  /** Counts toward nothing and can't be built: map-placed neutral cover (ruins). */
  neutral?: boolean;
}

export type DamageTable = Record<DamageType, Record<ArmorClass, number>>;

export interface RulesDef {
  startingSupply: number;
  startingMorale: number;
  /** Below this fraction of starting Morale a side is shaken: suppression wears off slower. */
  moraleLowFraction?: number;
  /** Suppression recovery multiplier while shaken. */
  moraleLowRecovery?: number;
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
  /** Morale per second per point the team is behind the leader. */
  bleedPerPointDiff: number;
  lateBleedSeconds: number;
  lateBleedMult: number;
  unitLossMoralePerCp: number;
  suddenDeathSeconds: number;
  /** Morale per second every team loses in sudden death. */
  suddenDeathBleed: number;
  suddenDeathHqDamageMult: number;
  tier3UnlockSeconds: number;
  buildRadius: number;
  lowPowerProductionMult: number;
  maxQueue: number;
  navCellSize: number;
  fogCellSize: number;
  fogUpdateTicks: number;
  /** Supply one truck carries per trip. */
  truckCapacity: number;
  /** Supply a source (point/depot) can hold waiting for pickup. */
  stockCap: number;
  truckRespawnSeconds: number;
  /** Units within this distance of a friendly supply node keep full readiness. */
  supplyRange: number;
  readinessMin: number;
  readinessDecayPerSecond: number;
  readinessRecoverPerSecond: number;
  /** Superweapon: seconds to charge, warning time, blast radius and damage. */
  superweaponSeconds?: number;
  superweaponWarningSeconds?: number;
  superweaponRadius?: number;
  superweaponDamage?: number;
  pausesPerPlayer?: number;
  /** Seconds a pause lasts before the game resumes by itself. */
  pauseMaxSeconds?: number;
  /** Morale-drain multiplier while a team holds every point (pushes a dominant side to finish). */
  sweepBleedMult?: number;
  /** Extra sudden-death bleed per second for every second sudden death has lasted. */
  suddenDeathRamp?: number;
  /** Comeback: +1 command point per this many points of Morale a team is behind the leader, up to cpComebackMax. */
  cpComebackPer?: number;
  cpComebackMax?: number;
  /** Comeback: extra HQ supply per second for every 100 Morale behind the leader, up to the max. */
  incomeComebackPer100?: number;
  incomeComebackMax?: number;
}


export type { MapShape } from '../shared/terrain';
/** Maps carry points, supply nodes, terrain etc. in the shared MapDef now. */
export type SimMapDef = MapDef;

/** What the sim needs. units + map are required (shared contract); the rest default to data/. */
export interface SimContent {
  units: Record<string, UnitDef>;
  map: MapDef;
  weapons?: Record<string, WeaponDef>;
  structures?: Record<string, StructureDef>;
  damage?: DamageTable;
  rules?: RulesDef;
  abilities?: Record<string, AbilityDef>;
}

export interface ResolvedContent {
  units: Record<string, SimUnitDef>;
  map: SimMapDef;
  weapons: Record<string, WeaponDef>;
  structures: Record<string, StructureDef>;
  damage: DamageTable;
  rules: RulesDef;
  abilities: Record<string, AbilityDef>;
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
    abilities: c.abilities ?? (abilitiesJson as Record<string, AbilityDef>),
  };
}

export function layerOf(domain: Domain): TargetLayer {
  return domain;
}
