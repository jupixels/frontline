// Demolishing your own buildings. Unfinished sites are cancelled on the spot with a full refund;
// finished buildings come down after a short countdown (visible to everyone) for half their cost.
// A demolition is not a loss: no Morale cost, no kill credit, no "destroyed" alert.

import { SIM_HZ, type EntityId, type PlayerId } from '../../shared/types';
import type { Entity, World } from '../world';
import { ejectAll } from './containers';

/** Seconds a finished building takes to come down. */
export const DEMOLISH_SECONDS = 5;
/** Share of a finished building's cost paid back. */
export const DEMOLISH_REFUND = 0.5;

/**
 * Who may demolish `s`: its owner, or a co-commander of that army who holds the logistics role
 * (anyone sharing command when nobody on the army has roles, or nobody holds logistics).
 */
export function canDemolish(world: World, player: PlayerId, s: Entity): boolean {
  if (s.kind !== 'structure' || s.dead || s.owner < 0 || s.structure?.neutral || s.homeOwner !== s.owner) return false;
  if (s.owner === player) return true;
  if (!world.commandsFor.get(player)?.has(s.owner)) return false;
  const role = world.roles.get(player);
  if (!role || role === 'logistics') return true;
  return !world.heldRoles.get(world.armyOf.get(player) ?? s.owner)?.has('logistics');
}

/** Why `s` can't be demolished right now, or null if it can. */
export function demolishBlocker(s: Entity): 'demolishHq' | null {
  return s.type === 'hq' ? 'demolishHq' : null;
}

function refundQueue(world: World, s: Entity): number {
  const p = world.players.get(s.owner);
  let n = 0;
  for (const q of s.queue) n += q.paid;
  if (p) p.supply += n;
  s.queue.length = 0;
  return n;
}

/** Take a structure off the map without a death: everyone out, queue paid back, then `refund`. */
function takeDown(world: World, s: Entity, refund: number): void {
  if (s.cargo.length) ejectAll(world, s, false);
  const total = refund + refundQueue(world, s);
  const p = world.players.get(s.owner);
  if (p) p.supply += refund;
  world.emit({ type: 'demolish', id: s.id, state: 'done', at: { x: s.pos.x, z: s.pos.z }, refund: total });
  world.remove(s.id);
}

/** `demolish` command. Each structure toggles: start (or cancel) its demolition. */
export function orderDemolish(world: World, player: PlayerId, ids: EntityId[]): void {
  if (!Array.isArray(ids)) return;
  const seen = new Set<EntityId>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = world.entities.get(id);
    if (!s || !canDemolish(world, player, s)) continue;
    const blocker = demolishBlocker(s);
    if (blocker) {
      world.emit({ type: 'blocked', player, reason: blocker });
      continue;
    }
    const at = { x: s.pos.x, z: s.pos.z };
    if (s.buildProgress < 1) {
      // Cancel construction: everything spent comes back.
      takeDown(world, s, s.structure?.cost ?? 0);
    } else if (s.demolishAt) {
      s.demolishAt = 0;
      world.emit({ type: 'demolish', id: s.id, state: 'cancelled', at, refund: 0 });
    } else {
      s.demolishAt = world.tick + DEMOLISH_SECONDS * SIM_HZ;
      world.emit({ type: 'demolish', id: s.id, state: 'started', at, refund: 0 });
    }
  }
}

/** Buildings whose countdown ran out come down. Runs before deaths so a dying building isn't refunded. */
export function demolishSystem(world: World): void {
  let due: Entity[] | null = null;
  for (const s of world.entities.values()) {
    if (s.demolishAt && !s.dead && world.tick >= s.demolishAt) (due ??= []).push(s);
  }
  if (!due) return;
  for (const s of due) takeDown(world, s, Math.floor((s.structure?.cost ?? 0) * DEMOLISH_REFUND));
}
