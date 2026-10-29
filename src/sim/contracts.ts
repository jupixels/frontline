// Shared-contract proposals from the sim workstream. These belong in src/shared/ once the master
// session promotes them; until then render/ui/ai can import the types from here (read-only use).

import type { Command, PlayerCommand } from '../shared/commands';
import type { EntityId, PlayerId, PlayerSlot, TeamId, Tick, Vec2 } from '../shared/types';

/** Proposed Command variant: activate an ability (data/abilities.json) on the given units. */
export interface UseAbilityCommand {
  type: 'useAbility';
  units: EntityId[];
  ability: string;
  /** For 'point' abilities. */
  at?: Vec2;
  /** For 'unit' abilities. */
  targetId?: EntityId;
  queue?: boolean;
}

/** Command union the sim accepts: the shared one plus proposals. */
export type SimCommand = Command | UseAbilityCommand;

export interface SimPlayerCommand {
  player: PlayerId;
  cmd: SimCommand;
}

export type AnyPlayerCommand = PlayerCommand | SimPlayerCommand;

/**
 * Proposed PlayerSlot field for shared-command co-op (Phase 3): the players whose units, buildings
 * and economy this player may also command. Omitted = only their own (today's behavior).
 */
export interface SimPlayerSlot extends PlayerSlot {
  commandsFor?: PlayerId[];
}

/**
 * Extra events, delivered through `Simulation.proposedEvents` so `step()` keeps returning the
 * shared `SimEvent[]` unchanged. Proposed for the shared SimEvent union.
 */
export type ProposedEvent =
  /** Indirect fire on its way: draw a target marker (the enemy sees it too, so they can dodge). */
  | { type: 'incoming'; weapon: string; by: EntityId; at: Vec2; radius: number; arrive: Tick }
  /** A structure foundation was placed (construction started). */
  | { type: 'placed'; id: EntityId; builder: EntityId }
  /** A capture point was neutralized (lost its owner). */
  | { type: 'neutralized'; point: EntityId; from: PlayerId }
  /** Production could not start or finish (no supply / no CP / requirements). */
  | { type: 'blocked'; player: PlayerId; reason: 'supply' | 'cp' | 'requirements' | 'placement' | 'queueFull' }
  /** Sudden death began: HQs lose armor and every team bleeds. */
  | { type: 'suddenDeath'; tick: Tick }
  /** An ability was activated (point/unit abilities: when cast, after moving into range). */
  | { type: 'abilityUsed'; id: EntityId; ability: string; at?: Vec2; targetId?: EntityId }
  /** Smoke cloud placed; blocks vision and targeting through it until `until`. */
  | { type: 'smoke'; at: Vec2; radius: number; until: Tick }
  /** Entrench state change: deploying, entrenched, packing, none. */
  | { type: 'entrench'; id: EntityId; state: 'deploying' | 'entrenched' | 'packing' | 'none' }
  /** An ambushing unit fired or was spotted and is visible again. */
  | { type: 'revealed'; id: EntityId }
  /** A supply truck delivered cargo to its HQ. */
  | { type: 'delivered'; truck: EntityId; player: PlayerId; amount: number };

/** Fog-of-war cell states. */
export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1;
export const FOG_VISIBLE = 2;

/**
 * Read-only fog of war, computed deterministically in the sim (so AI and lockstep agree).
 * Proposed for src/shared/. Grid cell (0,0) is the map's -x,-z corner; index = row * cols + col.
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

/** Player economy beyond the shared PlayerState. */
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

/** Proposed SimView extension for HUD build menus, queues and capture bars. */
export interface SimViewExt {
  readonly fog: FogView;
  economy(player: PlayerId): EconomyView | undefined;
  /** Production queue of a factory (front item first). */
  queue(factory: EntityId): readonly ProductionView[];
  rally(factory: EntityId): Vec2 | null;
  /** Structure construction progress 0..1 (1 = complete). */
  buildProgress(id: EntityId): number;
  /** Capture point state. */
  capture(point: EntityId): { owner: PlayerId; capturer: PlayerId; progress: number; radius: number } | undefined;
  /** Unit types `factory` can produce right now (tier/requirements met), and structures an engineer can build. */
  producible(factory: EntityId): string[];
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
  /** Match over: winning team, or null while playing. */
  readonly winner: TeamId | null;
}
