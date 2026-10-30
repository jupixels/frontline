import type { EntityId, Heading, PlayerId, Tick, Vec2 } from './types';

/**
 * Player intents. UI and AI only ever produce Commands; net/ orders them into Turns;
 * sim/ applies them. Commands must be plain JSON (they go over the wire and into replays).
 */
export type Command =
  | { type: 'move'; units: EntityId[]; target: Vec2; queue?: boolean; attackMove?: boolean; facing?: Heading }
  | { type: 'attack'; units: EntityId[]; targetId: EntityId; queue?: boolean }
  | { type: 'stop'; units: EntityId[] }
  | { type: 'hold'; units: EntityId[] }
  | { type: 'build'; builder: EntityId; structure: string; at: Vec2; rotation: number; queue?: boolean }
  | { type: 'produce'; factory: EntityId; unit: string; count: number }
  | { type: 'cancelProduce'; factory: EntityId; index: number }
  | { type: 'setRally'; factory: EntityId; at: Vec2 }
  /** Activate an ability (data/abilities.json). `at` for point abilities, `targetId` for unit abilities. */
  | { type: 'useAbility'; units: EntityId[]; ability: string; at?: Vec2; targetId?: EntityId; queue?: boolean }
  /** Attack-move back and forth between where each unit stands and `target` until told otherwise. */
  | { type: 'patrol'; units: EntityId[]; target: Vec2; queue?: boolean }
  /** Board a transport (IFV, transport heli, transport ship) or garrison a building/trench. */
  | { type: 'enter'; units: EntityId[]; target: EntityId; queue?: boolean }
  /** Containers drop their passengers: buildings at once, transports after moving to `at` (if given). */
  | { type: 'unload'; units: EntityId[]; at?: Vec2; queue?: boolean }
  /**
   * Hold a drawn frontline: units spread along the polyline by role, facing away from their side.
   * With `line` set, the units reinforce that existing line instead (weak spots first).
   */
  | { type: 'holdLine'; units: EntityId[]; points: Vec2[]; line?: number }
  /** Push a whole frontline forward (negative pulls it back) by `distance` meters. */
  | { type: 'advanceLine'; line: number; distance: number }
  /** Dissolve a frontline; its units stay where they are. */
  | { type: 'disbandLine'; line: number }
  /** Fire the player's superweapon (cruise missile) at a point. */
  | { type: 'superweapon'; at: Vec2 }
  /** Online pause vote: true asks to pause (passes with half the human players), false resumes. */
  | { type: 'pauseVote'; paused: boolean }
  | { type: 'surrender' };


export type UseAbilityCommand = Extract<Command, { type: 'useAbility' }>;

export type CommandType = Command['type'];

/** A command stamped with its issuer. The player id is set by net/, never trusted from the payload. */
export interface PlayerCommand {
  player: PlayerId;
  cmd: Command;
}

/** All commands to apply at one tick, in a canonical order every peer agrees on. */
export interface Turn {
  tick: Tick;
  commands: PlayerCommand[];
}
