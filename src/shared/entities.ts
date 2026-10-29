import type { EntityId, Heading, PlayerId, Tick, Vec2 } from './types';

export type EntityKind = 'unit' | 'structure' | 'projectile' | 'point';

/** What render/, audio/, ui/ and ai/ may read about an entity. Treat as read-only outside sim/. */
export interface EntityState {
  readonly id: EntityId;
  readonly kind: EntityKind;
  /** Key into data/units.json or data/structures.json. */
  readonly type: string;
  readonly owner: PlayerId;
  readonly pos: Readonly<Vec2>;
  readonly heading: Heading;
  /** World-space turret heading, if the unit has a turret. */
  readonly turretHeading?: Heading;
  readonly hp: number;
  readonly maxHp: number;
  /** True while the unit is moving this tick (drives Move/Idle animation). */
  readonly moving: boolean;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly supply: number;
  readonly power: number;
  readonly tickets: number;
  readonly defeated: boolean;
}

/** Read-only view of the simulation that other modules depend on. */
export interface SimView {
  readonly tick: Tick;
  entities(): Iterable<EntityState>;
  get(id: EntityId): EntityState | undefined;
  player(id: PlayerId): PlayerState | undefined;
}
