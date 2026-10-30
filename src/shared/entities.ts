import type { EntityId, Heading, PlayerId, TeamId, Tick, Vec2 } from './types';

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
  /** Transport or garrisoned structure this unit is inside (hidden from the map), if any. */
  readonly inside?: EntityId;
  /** Units carried by this transport / garrisoning this structure. */
  readonly cargo?: readonly EntityId[];
  /** Infantry suppression 0..1. Above SUPPRESS_PINNED the unit is prone: slow and inaccurate. */
  readonly suppression?: number;
  /** Veterancy rank 0..3. */
  readonly rank?: number;
  /** Frontline the unit holds (SimViewExt.lines), 0 = none. */
  readonly line?: number;
}

/** Suppression level at which infantry go prone. */
export const SUPPRESS_PINNED = 0.5;

/** A drawn frontline (holdLine). Allies see each other's lines. */
export interface FrontlineView {
  readonly id: number;
  readonly owner: PlayerId;
  readonly points: readonly Vec2[];
  /** Unit heading the line faces (away from the owner's side). */
  readonly facing: Heading;
  readonly units: readonly EntityId[];
  /** Per point segment, 0..1 relative strength (weak spots get reinforcements first). */
  readonly strength: readonly number[];
}

/** Strategic superweapon of a player (cruise missile from the Strategic Command). */
export interface SuperweaponView {
  /** Structure that fires it. */
  readonly site: EntityId;
  /** 0..1 charge; 1 = ready. */
  readonly charge: number;
  readonly ready: boolean;
}

/** Online pause vote state. */
export interface PauseView {
  readonly paused: boolean;
  /** Players who voted to pause (while not paused). */
  readonly votes: readonly PlayerId[];
  readonly needed: number;
  /** Pauses each player has left. */
  readonly left: Readonly<Record<number, number>>;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly supply: number;
  readonly power: number;
  readonly tickets: number;
  readonly defeated: boolean;
}

/** Fog-of-war cell states. */
export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1;
export const FOG_VISIBLE = 2;

/**
 * Read-only fog of war, computed deterministically in the sim (so AI and lockstep agree).
 * Grid cell (0,0) is the map's -x,-z corner; index = row * cols + col.
 */
export interface FogView {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Increments every time the grids are recomputed (a few times per second). */
  readonly version: number;
  /** Per-cell FOG_* values for the player's team. Do not mutate. */
  cells(player: PlayerId): Readonly<Uint8Array>;
  isVisible(player: PlayerId, x: number, z: number): boolean;
  isExplored(player: PlayerId, x: number, z: number): boolean;
  /** Whether `player` should see entity `id` right now (own/allied/neutral points always). */
  canSee(player: PlayerId, id: EntityId): boolean;
}

export interface ProductionView {
  readonly unit: string;
  /** 0..1 */
  readonly progress: number;
}

/** Player economy beyond PlayerState. */
export interface EconomyView {
  readonly team: TeamId;
  readonly supply: number;
  readonly power: number;
  readonly powerProduced: number;
  readonly powerUsed: number;
  readonly cp: number;
  readonly cpCap: number;
  readonly tier: number;
  readonly pointsHeld: number;
  /** Team tickets (members of a team share one pool). */
  readonly tickets: number;
}

/** Richer reads for HUD build menus, queues, capture bars, fog and AI. Implemented by Simulation. */
export interface SimViewExt {
  readonly fog: FogView;
  economy(player: PlayerId): EconomyView | undefined;
  /** Production queue of a factory (front item first). */
  queue(factory: EntityId): readonly ProductionView[];
  rally(factory: EntityId): Vec2 | null;
  /** Structure construction progress 0..1 (1 = complete). */
  buildProgress(id: EntityId): number;
  capture(point: EntityId): { owner: PlayerId; capturer: PlayerId; progress: number; radius: number } | undefined;
  /** Unit types `factory` can produce right now (tier/requirements met). */
  producible(factory: EntityId): string[];
  /** Structures `player`'s builders can place right now. */
  buildable(player: PlayerId): string[];
  /** Whether a `build` command would be accepted at this spot (for the placement ghost). */
  canPlace(player: PlayerId, structure: string, at: Vec2, rotation: number): boolean;
  /** Abilities of a unit with remaining cooldown (0..1 of the full cooldown, 0 = ready). */
  abilities(id: EntityId): readonly { ability: string; cooldown: number; active: boolean }[];
  /** 0.5..1: fire rate and accuracy factor from distance to friendly supply. */
  readiness(id: EntityId): number;
  /** Supply waiting at a source (capture point / depot) for a truck. */
  stock(id: EntityId): number;
  /** Whether `player` may give orders to `id` (owner, or shared command). */
  canCommand(player: PlayerId, id: EntityId): boolean;
  /** Frontlines owned by `player` and allies. */
  lines(player: PlayerId): readonly FrontlineView[];
  /** The player's superweapon, if they have built one. */
  superweapon(player: PlayerId): SuperweaponView | null;
  readonly pause: PauseView;
  /** Ground height at (x, z) (bridge decks included), same as the renderer draws. */
  heightAt(x: number, z: number): number;
  /** Whether `unit` may board/garrison `container` right now (type, seats, ownership). */
  canEnter(unit: EntityId, container: EntityId): boolean;
  /** Static terrain reachability (ignores structures): can `domain` travel from a to b? */
  reachable(domain: 'ground' | 'naval', a: Vec2, b: Vec2): boolean;
  /** Match over: winning team, or null while playing. */
  readonly winner: TeamId | null;
}

/** Read-only view of the simulation that other modules depend on. */
export interface SimView {
  /** Step counter (lockstep turns). Keeps counting while the game is paused. */
  readonly tick: Tick;
  /** Game time in ticks: stops while paused. Use it for clocks and countdowns. */
  readonly gameTick?: Tick;

  entities(): Iterable<EntityState>;
  get(id: EntityId): EntityState | undefined;
  player(id: PlayerId): PlayerState | undefined;
}
