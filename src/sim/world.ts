import type { UnitDef, MapDef } from '../shared/data';
import type { EntityKind, EntityState, PlayerState } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, Heading, MatchSetup, PlayerId, TeamId, Tick, Vec2 } from '../shared/types';
import { Prng } from './math/prng';

export type Order =
  | { kind: 'move'; target: Vec2; attackMove: boolean }
  | { kind: 'attack'; targetId: EntityId }
  | { kind: 'hold' };

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
  def: UnitDef;
  order: Order | null;
  orderQueue: Order[];
}

export interface Player extends PlayerState {
  supply: number;
  power: number;
  tickets: number;
  defeated: boolean;
  team: TeamId;
}

export interface SimContent {
  units: Record<string, UnitDef>;
  map: MapDef;
}

export class World {
  tick: Tick = 0;
  readonly rng: Prng;
  /** Insertion order == creation order == id order, which keeps iteration deterministic. */
  readonly entities = new Map<EntityId, Entity>();
  readonly players = new Map<PlayerId, Player>();
  events: SimEvent[] = [];
  private nextId: EntityId = 1;

  constructor(
    readonly setup: MatchSetup,
    readonly content: SimContent,
  ) {
    this.rng = new Prng(setup.seed);
    for (const slot of setup.players) {
      this.players.set(slot.id, {
        id: slot.id,
        team: slot.team,
        supply: 1000,
        power: 0,
        tickets: 1000,
        defeated: false,
      });
    }
  }

  emit(e: SimEvent): void {
    this.events.push(e);
  }

  spawnUnit(type: string, owner: PlayerId, pos: Vec2, heading: Heading): Entity {
    const def = this.content.units[type];
    if (!def) throw new Error(`Unknown unit type "${type}"`);
    const e: Entity = {
      id: this.nextId++,
      kind: 'unit',
      type,
      owner,
      pos: { x: pos.x, z: pos.z },
      heading,
      turretHeading: def.turretNode ? heading : undefined,
      hp: def.hp,
      maxHp: def.hp,
      moving: false,
      def,
      order: null,
      orderQueue: [],
    };
    this.entities.set(e.id, e);
    this.emit({ type: 'spawned', id: e.id });
    return e;
  }

  remove(id: EntityId): void {
    if (this.entities.delete(id)) this.emit({ type: 'removed', id });
  }
}
