import type { Command, Turn } from '../shared/commands';
import type { PlayerId, Tick } from '../shared/types';

/**
 * Orders commands from all players into Turns. The match loop only steps the sim when
 * `pollTurn` returns a Turn, so a lagging peer stalls everyone (lockstep).
 */
export interface NetSession {
  readonly localPlayer: PlayerId;
  /** Queue a command from local input (or a local AI); it is scheduled for a future tick. */
  submit(cmd: Command, player?: PlayerId): void;
  /** The turn for `tick` once every player's input for it is known, else null (stall). */
  pollTurn(tick: Tick): Turn | null;
  /** Called periodically with the local state hash so peers can detect desyncs. */
  reportHash(tick: Tick, hash: number): void;
  dispose(): void;
}

/**
 * Single-machine session for skirmish vs AI and offline testing.
 * Commands apply on the next tick. `player` lets local AIs submit as their own slot.
 */
export class LocalSession implements NetSession {
  private pending: Turn['commands'] = [];

  constructor(readonly localPlayer: PlayerId) {}

  submit(cmd: Command, player: PlayerId = this.localPlayer): void {
    this.pending.push({ player, cmd });
  }

  pollTurn(tick: Tick): Turn {
    const commands = this.pending;
    this.pending = [];
    return { tick, commands };
  }

  reportHash(): void {}

  dispose(): void {}
}
