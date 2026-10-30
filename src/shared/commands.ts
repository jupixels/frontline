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
