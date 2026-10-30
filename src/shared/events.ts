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
  | { type: 'victory'; team: TeamId; tick: Tick }
  /** Indirect fire on its way: draw a target marker (the enemy sees it too, so they can dodge). */
  | { type: 'incoming'; weapon: string; by: EntityId; at: Vec2; radius: number; arrive: Tick }
  /** A structure foundation was placed (construction started). */
  | { type: 'placed'; id: EntityId; builder: EntityId }
  /** A capture point lost its owner. */
  | { type: 'neutralized'; point: EntityId; from: PlayerId }
  /** Production or placement was refused. */
  | { type: 'blocked'; player: PlayerId; reason: 'supply' | 'cp' | 'requirements' | 'placement' | 'queueFull' }
  /** Sudden death began: HQs lose armor and every team bleeds. */
  | { type: 'suddenDeath'; tick: Tick }
  | { type: 'abilityUsed'; id: EntityId; ability: string; at?: Vec2; targetId?: EntityId }
  /** Smoke cloud; blocks vision and targeting through it until `until`. */
  | { type: 'smoke'; at: Vec2; radius: number; until: Tick }
  | { type: 'entrench'; id: EntityId; state: 'deploying' | 'entrenched' | 'packing' | 'none' }
  /** An ambushing unit fired or was spotted and is visible again. */
  | { type: 'revealed'; id: EntityId }
  /** A supply truck delivered cargo to its HQ. */
  | { type: 'delivered'; truck: EntityId; player: PlayerId; amount: number };

export type SimEventType = SimEvent['type'];
