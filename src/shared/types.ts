// Core ids and constants shared by every module. Changes here go through the master session.

export type EntityId = number;
/** 0..MAX_PLAYERS-1. -1 means neutral / unowned. */
export type PlayerId = number;
export type TeamId = number;
/** Simulation step index, starting at 0. */
export type Tick = number;

export const NEUTRAL: PlayerId = -1;
export const MAX_PLAYERS = 8;

/** Fixed simulation rate. Rendering interpolates between ticks. */
export const SIM_HZ = 20;
export const TICK_SECONDS = 1 / SIM_HZ;
export const TICK_MS = 1000 / SIM_HZ;

/**
 * Ground-plane position in meters. Sim works in 2D (x, z); height comes from the terrain.
 * Matches three.js world axes: +x east, +z south, y up.
 */
export interface Vec2 {
  x: number;
  z: number;
}

/**
 * Heading convention (radians): forward vector is (sin h, cos h) on (x, z).
 * h = 0 faces +z. In three.js this is exactly `object.rotation.y = h`.
 */
export type Heading = number;

export interface PlayerSlot {
  id: PlayerId;
  team: TeamId;
  name: string;
  /** CSS hex color, e.g. "#3a7bd5". */
  color: string;
  kind: 'human' | 'ai';
  aiDifficulty?: 'easy' | 'normal' | 'hard';
  /** Shared-command co-op: other players whose units, buildings and economy this player may also command. */
  commandsFor?: PlayerId[];
  /**
   * Shared-command co-op: this player has no army of its own and commands `army`'s instead (one
   * base, one economy). `army` must be a teammate that is not itself a co-commander.
   */
  army?: PlayerId;
  /** Optional co-op role. Limits which units and buildings of the shared army this player may order. */
  role?: CommandRole;
}

/**
 * Co-op roles. ground: infantry, vehicles, barracks and war factory; air: aircraft, helipad and
 * airfield; navy: ships and the naval yard; logistics: engineers, supply trucks, HQ and every other
 * building (construction, economy, superweapon). A role nobody on the army holds is open to all.
 */
export type CommandRole = 'ground' | 'air' | 'navy' | 'logistics';
export const COMMAND_ROLES: readonly CommandRole[] = ['ground', 'air', 'navy', 'logistics'];

export type VictoryMode = 'frontline' | 'annihilation';

/** Everything needed to start an identical simulation on every peer. */
export interface MatchSetup {
  seed: number;
  mapId: string;
  players: PlayerSlot[];
  victory: VictoryMode;
}
