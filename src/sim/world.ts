import type { ArmorClass, Domain, MapDef, UnitDef } from '../shared/data';
import type { EntityKind, EntityState, PlayerState } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, Heading, MatchSetup, PlayerId, TeamId, Tick, Vec2 } from '../shared/types';
import { NEUTRAL, SIM_HZ } from '../shared/types';
import { resolveContent, type AbilityDef, type ResolvedContent, type SimContent, type SimUnitDef, type StructureDef, type TargetLayer, type WeaponDef } from './content';
import type { ProposedEvent, SimPlayerSlot } from './contracts';
import { Prng } from './math/prng';
import { FogOfWar } from './systems/fog';
import { FlowFieldCache, type FlowField } from './path/flowfield';
import { NavGrid, type CellRect } from './path/navgrid';
import { SpatialHash } from './path/spatial';

export type { SimContent } from './content';

export type Order =
  | { kind: 'move'; target: Vec2; attackMove: boolean }
  | { kind: 'attack'; targetId: EntityId }
  | { kind: 'hold' }
  | { kind: 'build'; siteId: EntityId }
  | { kind: 'ability'; ability: string; at: Vec2; targetId: EntityId }
  /** Attack-move between `a` and `b`; `toB` says which way the current leg goes. */
  | { kind: 'patrol'; a: Vec2; b: Vec2; toB: boolean }
  /** Walk to a transport/building and get in. */
  | { kind: 'enter'; targetId: EntityId }
  /** Containers: go to `at` (transports) and drop everyone. */
  | { kind: 'unload'; at: Vec2 | null }
  /** Hold a slot on frontline `lineId` (slot position kept in Entity.lineSlot). */
  | { kind: 'line'; lineId: number };

export interface AbilityState {
  id: string;
  def: AbilityDef;
  /** Ticks until usable again. */
  cooldown: number;
}

export type EntrenchState = 'none' | 'deploying' | 'entrenched' | 'packing';

/** Supply truck state machine. */
export interface Haul {
  source: EntityId;
  phase: 'toSource' | 'toHq';
  cargo: number;
}

export interface Smoke {
  at: Vec2;
  radius: number;
  until: Tick;
}

/** Barrage in progress: `left` more shells from `caster` at `at`. */
export interface Barrage {
  caster: EntityId;
  weapon: string;
  at: Vec2;
  radius: number;
  left: number;
  next: Tick;
  interval: number;
}

export interface PathState {
  /** Where this unit is going (its formation slot). */
  goal: Vec2;
  /** Built on demand toward `fieldCell` (shared by a group). */
  field: FlowField | null;
  fieldCell: number;
  /** Straight line to goal is clear, re-checked every few ticks. */
  direct: boolean;
  checkedAt: Tick;
}

export interface WeaponState {
  id: string;
  def: WeaponDef;
  /** Ticks until it can fire again. */
  cooldown: number;
}

export interface ProductionItem {
  unit: string;
  /** Ticks of work done. */
  progress: number;
  total: number;
  /** Supply paid (refunded on cancel). */
  paid: number;
}

/** In-flight shot. Kept outside the entity map; render learns of it via fired/impact events. */
export interface Projectile {
  weapon: string;
  def: WeaponDef;
  shooter: EntityId;
  owner: PlayerId;
  team: TeamId;
  from: Vec2;
  at: Vec2;
  targetId: EntityId;
  /** Direct shots roll accuracy at fire time; a hit always lands on the target. */
  hits: boolean;
  arrive: Tick;
  /** Damage multiplier fixed at fire time (ambush bonus). */
  mult: number;
}

/** Mutable sim-internal entity. Only sim/ sees this type; everyone else gets EntityState. */
export interface Entity extends EntityState {
  kind: EntityKind;
  owner: PlayerId;
  pos: Vec2;
  heading: Heading;
  turretHeading?: Heading;
  hp: number;
  maxHp: number;
  moving: boolean;

  team: TeamId;
  radius: number;
  sight: number;
  armor: ArmorClass;
  /** Movement domain (structures and points are 'ground' but never move). */
  domain: Domain;
  layer: TargetLayer;
  unit?: SimUnitDef;
  structure?: StructureDef;
  /** CP this entity occupies. */
  cp: number;

  order: Order | null;
  orderQueue: Order[];
  path: PathState | null;
  /** Where an idle unit returns to after chasing. */
  guard: Vec2 | null;

  weapons: WeaponState[];
  target: EntityId;
  retargetAt: Tick;
  dead: boolean;
  killer?: EntityId;
  /** Set by targetingSystem when combat is steering this unit this tick. */
  busy: boolean;
  /** `path` currently belongs to a combat chase, not to the order. */
  chasing: boolean;

  /** Structures: 0..1, 1 = complete. Units/points: 1. */
  buildProgress: number;
  footprint?: CellRect;
  queue: ProductionItem[];
  rally: Vec2 | null;

  abilities: AbilityState[];
  /** Sprint/overdrive: speed multiplier active until `boostUntil`. */
  boostUntil: Tick;
  boostMult: number;
  entrench: EntrenchState;
  /** Tick the current entrench transition completes. */
  entrenchAt: Tick;
  entrenchDamage: number;
  /** Ambush armed: hidden from enemies while stationary until it fires. */
  ambush: boolean;
  ambushBonus: number;
  /** 0.5..1, falls when far from friendly supply. Scales fire rate and accuracy. */
  readiness: number;
  /** Supply sources (points, depots): supply waiting for a truck, and the truck serving it. */
  stock: number;
  truck: EntityId;
  truckReadyAt: Tick;
  haul: Haul | null;

  /** Capture points: 0..1 progress toward `capturer` (or toward owner when owned). */
  captureProgress: number;
  capturer: PlayerId;
  captureRadius: number;

  /** Container this unit rides in / garrisons (0 = on the map). */
  inside: EntityId;
  /** Units inside this transport or structure, in boarding order. */
  cargo: EntityId[];
  /** Seats this container offers (0 = not a container). */
  capacity: number;
  /** Infantry suppression 0..1, and when it last went up. */
  suppression: number;
  suppressedAt: Tick;
  pinned: boolean;
  /** Veterancy: experience (damage dealt, weighted by target value) and rank 0..3. */
  xp: number;
  rank: number;
  /** Last tick this entity took damage (rank 3 self-heal waits for quiet). */
  hurtAt: Tick;
  /** Frontline membership and assigned slot. */
  line: number;
  lineSlot: Vec2 | null;
  /** Owner before a neutral building was garrisoned (reverts when empty). */
  homeOwner: PlayerId;
  /** Line-of-fire cache (combat). */
  losTarget: EntityId;
  losAt: Tick;
  losOk: boolean;
}

/** A drawn frontline: polyline plus members. Slots are assigned by systems/lines.ts. */
export interface Frontline {
  id: number;
  owner: PlayerId;
  team: TeamId;
  points: Vec2[];
  facing: Heading;
  units: EntityId[];
  strength: number[];
  /** Slots need recomputing (membership or shape changed). */
  dirty: boolean;
}

/** Cruise missile in flight. */
export interface Missile {
  player: PlayerId;
  team: TeamId;
  site: EntityId;
  at: Vec2;
  arrive: Tick;
}

export interface Player extends PlayerState {
  supply: number;
  /** Net power (produced - used). Shared PlayerState.power. */
  power: number;
  tickets: number;
  defeated: boolean;
  team: TeamId;
  powerProduced: number;
  powerUsed: number;
  cp: number;
  cpCap: number;
  tier: number;
  pointsHeld: number;
  /** Completed structures per type. */
  structures: Map<string, number>;
  hadHq: boolean;
  lastAlertTick: Tick;
  /** Superweapon charge in ticks of the full cooldown (ready when >= superweaponTicks). */
  superCharge: number;
  superReadyAnnounced: boolean;
  /** Pauses this player may still start (online pause votes). */
  pausesLeft: number;
}

export interface Team {
  id: TeamId;
  tickets: number;
  defeated: boolean;
}

export class World {
  tick: Tick = 0;
  readonly rng: Prng;
  readonly content: ResolvedContent;
  /** Insertion order == creation order == id order, which keeps iteration deterministic. */
  readonly entities = new Map<EntityId, Entity>();
  readonly players = new Map<PlayerId, Player>();
  readonly teams = new Map<TeamId, Team>();
  readonly nav: NavGrid;
  readonly fields: FlowFieldCache;
  /** Rebuilt each tick: every living unit and structure. */
  readonly spatial: SpatialHash<Entity>;
  projectiles: Projectile[] = [];
  smokes: Smoke[] = [];
  barrages: Barrage[] = [];
  missiles: Missile[] = [];
  readonly lines = new Map<number, Frontline>();
  nextLineId = 1;
  /** Online pause: whether the game is paused, votes to pause, and the step it was paused at. */
  paused = false;
  pauseVotes: PlayerId[] = [];
  pauseVoteTick = 0;
  pausedAtStep = 0;
  pausedBy: PlayerId = -1;
  /** Steps taken, including paused ones (Simulation.tick). `tick` is game time. */
  steps = 0;
  /** player -> owners whose stuff they may command (besides their own). See canCommand. */
  readonly commandsFor = new Map<PlayerId, Set<PlayerId>>();
  events: SimEvent[] = [];
  /** Events not yet in the shared SimEvent union (see contracts.ts). */
  proposed: ProposedEvent[] = [];
  winner: TeamId | null = null;
  over = false;
  suddenDeath = false;
  readonly fog: FogOfWar;
  private nextId: EntityId = 1;

  constructor(
    readonly setup: MatchSetup,
    content: SimContent,
  ) {
    this.content = resolveContent(content);
    this.rng = new Prng(setup.seed);
    const map = this.content.map;
    this.nav = new NavGrid(map, this.content.rules.navCellSize);
    this.fields = new FlowFieldCache(this.nav, 96);
    this.spatial = new SpatialHash<Entity>(map.size / 2, 16);
    const r = this.content.rules;
    for (const slot of setup.players) {
      this.players.set(slot.id, {
        id: slot.id,
        team: slot.team,
        supply: r.startingSupply,
        power: 0,
        tickets: r.startingTickets,
        defeated: false,
        powerProduced: 0,
        powerUsed: 0,
        cp: 0,
        cpCap: r.baseCp,
        tier: 1,
        pointsHeld: 0,
        structures: new Map(),
        hadHq: false,
        lastAlertTick: -100000,
        superCharge: 0,
        superReadyAnnounced: false,
        pausesLeft: r.pausesPerPlayer ?? 3,
      });
      if (!this.teams.has(slot.team)) this.teams.set(slot.team, { id: slot.team, tickets: r.startingTickets, defeated: false });
    }
    for (const slot of setup.players as SimPlayerSlot[]) {
      const others = (slot.commandsFor ?? []).filter((o) => o !== slot.id && setup.players.some((p) => p.id === o));
      if (others.length) this.commandsFor.set(slot.id, new Set(others));
    }
    this.fog = new FogOfWar(this);
  }

  get map(): MapDef {
    return this.content.map;
  }

  emit(e: SimEvent): void {
    this.events.push(e);
  }

  teamOf(player: PlayerId): TeamId {
    return this.players.get(player)?.team ?? -1;
  }

  seconds(): number {
    return this.tick / SIM_HZ;
  }

  private base(kind: EntityKind, type: string, owner: PlayerId, pos: Vec2, heading: Heading): Entity {
    return {
      id: this.nextId++,
      kind,
      type,
      owner,
      pos: { x: pos.x, z: pos.z },
      heading,
      hp: 1,
      maxHp: 1,
      moving: false,
      team: owner === NEUTRAL ? -1 : this.teamOf(owner),
      radius: 1,
      sight: 0,
      armor: 'structure',
      domain: 'ground',
      layer: 'ground',
      cp: 0,
      order: null,
      orderQueue: [],
      path: null,
      guard: null,
      weapons: [],
      target: 0,
      retargetAt: 0,
      dead: false,
      busy: false,
      chasing: false,
      buildProgress: 1,
      queue: [],
      rally: null,
      captureProgress: 0,
      capturer: NEUTRAL,
      captureRadius: 0,
      abilities: [],
      boostUntil: 0,
      boostMult: 1,
      entrench: 'none',
      entrenchAt: 0,
      entrenchDamage: 1,
      ambush: false,
      ambushBonus: 1,
      readiness: 1,
      stock: 0,
      truck: 0,
      truckReadyAt: 0,
      haul: null,
      inside: 0,
      cargo: [],
      capacity: 0,
      suppression: 0,
      suppressedAt: 0,
      pinned: false,
      xp: 0,
      rank: 0,
      hurtAt: -100000,
      line: 0,
      lineSlot: null,
      homeOwner: owner,
      losTarget: 0,
      losAt: -100,
      losOk: false,
    };
  }

  /** Ground height at (x, z), bridge decks included. */
  heightAt(x: number, z: number): number {
    return this.nav.heightAt(x, z);
  }

  private weaponsFor(ids: string[]): WeaponState[] {
    return ids.map((id) => {
      const def = this.content.weapons[id];
      if (!def) throw new Error(`Unknown weapon "${id}"`);
      return { id, def, cooldown: 0 };
    });
  }

  private add(e: Entity): Entity {
    this.entities.set(e.id, e);
    this.emit({ type: 'spawned', id: e.id });
    return e;
  }

  spawnUnit(type: string, owner: PlayerId, pos: Vec2, heading: Heading, cpShare?: number): Entity {
    const def = this.content.units[type] as SimUnitDef | undefined;
    if (!def) throw new Error(`Unknown unit type "${type}"`);
    const e = this.base('unit', type, owner, this.nav.snap(pos, def.domain), heading);
    e.unit = def;
    e.hp = e.maxHp = def.hp;
    e.radius = def.radius;
    e.sight = def.sight;
    e.armor = def.armor;
    e.domain = def.domain;
    e.layer = def.domain;
    e.cp = cpShare ?? def.cp / (def.squad ?? 1);
    e.weapons = this.weaponsFor(def.weapons);
    e.guard = { x: e.pos.x, z: e.pos.z };
    e.capacity = def.transport?.seats ?? 0;
    e.abilities = (def.abilities ?? []).map((id) => {
      const ad = this.content.abilities[id];
      if (!ad) throw new Error(`Unknown ability "${id}"`);
      return { id, def: ad, cooldown: 0 };
    });
    if (def.turretNode || e.weapons.some((w) => w.def.mount === 'turret')) e.turretHeading = heading;
    return this.add(e);
  }

  /** Places a structure. `complete` skips construction (starting HQ). Caller validates placement. */
  spawnStructure(type: string, owner: PlayerId, pos: Vec2, rotation: Heading, complete: boolean): Entity {
    const def = this.content.structures[type];
    if (!def) throw new Error(`Unknown structure type "${type}"`);
    const e = this.base('structure', type, owner, pos, rotation);
    const [w, d] = footprintSize(def, rotation);
    e.structure = def;
    e.maxHp = def.hp;
    e.hp = complete ? def.hp : Math.max(1, def.hp * 0.1);
    e.buildProgress = complete ? 1 : 0;
    e.radius = Math.sqrt(w * w + d * d) / 2;
    e.sight = def.sight;
    e.weapons = this.weaponsFor(def.weapons ?? []);
    e.capacity = def.garrison ?? 0;
    if (e.weapons.some((wp) => wp.def.mount === 'turret')) e.turretHeading = rotation;
    e.footprint = this.nav.footprintCells(pos, w, d);
    this.nav.occupy(e.footprint, 1);
    if (type === 'hq') {
      const p = this.players.get(owner);
      if (p) p.hadHq = true;
    }
    return this.add(e);
  }

  spawnPoint(pos: Vec2, radius: number): Entity {
    const e = this.base('point', 'capture_point', NEUTRAL, pos, 0);
    e.hp = 0;
    e.maxHp = 100;
    e.radius = radius;
    e.captureRadius = radius;
    return this.add(e);
  }

  /** Remove immediately (no death). Frees nav occupancy for structures. */
  remove(id: EntityId): void {
    const e = this.entities.get(id);
    if (!e) return;
    if (e.footprint) this.nav.occupy(e.footprint, -1);
    this.entities.delete(id);
    this.emit({ type: 'removed', id });
  }

  rebuildSpatial(): void {
    this.spatial.clear();
    for (const e of this.entities.values()) if (!e.dead && e.kind !== 'point' && !e.inside) this.spatial.insert(e);
  }


  areEnemies(a: TeamId, b: TeamId): boolean {
    return a !== b && a >= 0 && b >= 0;
  }
}

/**
 * Whether `player` may give orders to `e`. Owner by default; shared-command co-op adds the owners
 * listed in the player's `commandsFor`. Every command handler goes through this.
 */
export function canCommand(world: World, player: PlayerId, e: Entity): boolean {
  if (e.owner < 0) return false;
  return e.owner === player || !!world.commandsFor.get(player)?.has(e.owner);
}

/** Footprint w (x) and d (z), swapped when the structure is rotated by roughly 90 degrees. */
export function footprintSize(def: StructureDef, rotation: Heading): [number, number] {
  const [w, d] = def.footprint;
  const q = Math.round(rotation / 1.5707963267948966);
  return q % 2 === 0 ? [w, d] : [d, w];
}

export function unitDefOf(world: World, type: string): SimUnitDef | undefined {
  return world.content.units[type] as SimUnitDef | undefined;
}

export type { UnitDef };
