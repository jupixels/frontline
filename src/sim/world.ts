import type { ArmorClass, Domain, MapDef, UnitDef } from '../shared/data';
import type { EntityKind, EntityState, PlayerState } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, Heading, MatchSetup, PlayerId, TeamId, Tick, Vec2 } from '../shared/types';
import { NEUTRAL, SIM_HZ } from '../shared/types';
import { resolveContent, type ResolvedContent, type SimContent, type SimUnitDef, type StructureDef, type TargetLayer, type WeaponDef } from './content';
import type { ProposedEvent } from './contracts';
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
  | { kind: 'build'; siteId: EntityId };

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

  /** Capture points: 0..1 progress toward `capturer` (or toward owner when owned). */
  captureProgress: number;
  capturer: PlayerId;
  captureRadius: number;
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
    this.fields = new FlowFieldCache(this.nav);
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
      });
      if (!this.teams.has(slot.team)) this.teams.set(slot.team, { id: slot.team, tickets: r.startingTickets, defeated: false });
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
    };
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
    for (const e of this.entities.values()) if (!e.dead && e.kind !== 'point') this.spatial.insert(e);
  }

  areEnemies(a: TeamId, b: TeamId): boolean {
    return a !== b && a >= 0 && b >= 0;
  }
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
