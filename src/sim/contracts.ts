// The sim's contract proposals were promoted to src/shared/. These aliases keep existing
// imports working; new code should import from src/shared/ directly.

import type { PlayerCommand } from '../shared/commands';
import type { SimEvent } from '../shared/events';
import type { PlayerSlot } from '../shared/types';

export type { UseAbilityCommand } from '../shared/commands';
export type { Command as SimCommand, PlayerCommand as SimPlayerCommand } from '../shared/commands';
export type { EconomyView, FogView, ProductionView, SimViewExt } from '../shared/entities';
export { FOG_EXPLORED, FOG_UNEXPLORED, FOG_VISIBLE } from '../shared/entities';

export type AnyPlayerCommand = PlayerCommand;
export type SimPlayerSlot = PlayerSlot;

/** Events still delivered through `Simulation.proposedEvents` (now part of the shared SimEvent union). */
export type ProposedEvent = Extract<
  SimEvent,
  {
    type:
      | 'incoming'
      | 'placed'
      | 'neutralized'
      | 'blocked'
      | 'suddenDeath'
      | 'abilityUsed'
      | 'smoke'
      | 'entrench'
      | 'revealed'
      | 'delivered';
  }
>;
