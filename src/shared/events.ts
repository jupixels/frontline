import type { EntityId, PlayerId, TeamId, Tick, Vec2 } from './types';

/**
 * Things that happened during a sim step, for render/ (VFX, animation) and audio/ (sounds, voices).
 * Events are presentation hints only; nothing in sim/ may depend on who consumes them.
 */
export type SimEvent =
  | { type: 'spawned'; id: EntityId }
  | { type: 'removed'; id: EntityId }
  | { type: 'died'; id: EntityId; killer?: EntityId }
  | { type: 'ordered'; player: PlayerId; units: EntityId[]; order: 'move' | 'attack' | 'stop' | 'hold' | 'build' }
  | { type: 'fired'; id: EntityId; weapon: string; target?: EntityId; at: Vec2 }
  | { type: 'hit'; id: EntityId; by?: EntityId; damage: number; at: Vec2 }
  | { type: 'impact'; weapon: string; at: Vec2 }
  | { type: 'produced'; factory: EntityId; unit: EntityId }
  | { type: 'built'; id: EntityId }
  | { type: 'captured'; point: EntityId; by: PlayerId }
  | { type: 'underAttack'; player: PlayerId; at: Vec2 }
  | { type: 'defeated'; player: PlayerId }
  | { type: 'victory'; team: TeamId; tick: Tick };

export type SimEventType = SimEvent['type'];
