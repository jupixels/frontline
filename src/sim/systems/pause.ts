// Online pause votes. A pause starts once half the human players (at least one) vote for it; each
// player can start only a few pauses, anyone may resume after a short grace period, and a pause
// ends by itself after `pauseMaxSeconds`. While paused the sim keeps stepping (lockstep turns go on)
// but game time stands still.

import { SIM_HZ, type PlayerId } from '../../shared/types';
import type { World } from '../world';

/** Votes lapse if the pause doesn't pass within this long. */
const VOTE_TTL_STEPS = SIM_HZ * 30;
/** Nobody but the pauser can resume during the first seconds. */
const RESUME_GRACE_STEPS = SIM_HZ * 3;

function humans(world: World): PlayerId[] {
  return world.setup.players.filter((s) => s.kind === 'human' && !world.players.get(s.id)?.defeated).map((s) => s.id);
}

export function votesNeeded(world: World): number {
  return Math.max(1, Math.ceil(humans(world).length / 2));
}

export function pauseVote(world: World, player: PlayerId, paused: boolean): void {
  if (!humans(world).includes(player)) return;
  const needed = votesNeeded(world);
  if (paused) {
    if (world.paused || world.pauseVotes.includes(player)) return;
    const p = world.players.get(player)!;
    // The vote that would start a pause needs the starter to have pauses left.
    if (!world.pauseVotes.length && p.pausesLeft <= 0) {
      world.emit({ type: 'blocked', player, reason: 'requirements' });
      return;
    }
    if (!world.pauseVotes.length) world.pauseVoteTick = world.steps;
    world.pauseVotes.push(player);
    world.emit({ type: 'pauseVote', player, paused: true, votes: world.pauseVotes.length, needed });
    if (world.pauseVotes.length >= needed) {
      const starter = world.players.get(world.pauseVotes[0])!;
      starter.pausesLeft--;
      world.paused = true;
      world.pausedAtStep = world.steps;
      world.pausedBy = world.pauseVotes[0];
      world.pauseVotes = [];
      world.emit({ type: 'paused', paused: true, by: world.pausedBy });
    }
    return;
  }
  if (!world.paused) {
    // Withdraw a vote.
    const i = world.pauseVotes.indexOf(player);
    if (i >= 0) {
      world.pauseVotes.splice(i, 1);
      world.emit({ type: 'pauseVote', player, paused: false, votes: world.pauseVotes.length, needed });
    }
    return;
  }
  if (player !== world.pausedBy && world.steps - world.pausedAtStep < RESUME_GRACE_STEPS) return;
  resume(world, player);
}

function resume(world: World, by: PlayerId): void {
  world.paused = false;
  world.pauseVotes = [];
  world.emit({ type: 'paused', paused: false, by });
}

/** Expire stale votes and over-long pauses. Runs every step, paused or not. */
export function pauseSystem(world: World): void {
  if (world.paused) {
    const max = Math.round((world.content.rules.pauseMaxSeconds ?? 90) * SIM_HZ);
    if (world.steps - world.pausedAtStep >= max) resume(world, -1);
  } else if (world.pauseVotes.length && world.steps - world.pauseVoteTick > VOTE_TTL_STEPS) {
    world.pauseVotes = [];
    world.emit({ type: 'pauseVote', player: -1, paused: false, votes: 0, needed: votesNeeded(world) });
  }
}
