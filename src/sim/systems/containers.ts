// Transports (IFV, transport helicopter, transport ship) and garrisons (buildings, trenches, neutral
// ruins). Passengers ride hidden and can't fire; garrisons fire out and only the building can be hit.

import { NEUTRAL, type EntityId, type PlayerId, type Vec2 } from '../../shared/types';
import { dcos, dsin, PI, TWO_PI } from '../math/dmath';
import { canCommand, type Entity, type World } from '../world';
import { packUp } from './abilities';
import { leaveLine } from './lines';
import { followPath, nextOrder, setPath } from './movement';

/** Seats a unit takes: infantry 1, light vehicles 4, heavy 6 (data can override). */
export function seatsOf(u: Entity): number {
  return u.unit?.seats ?? (u.armor === 'infantry' ? 1 : u.armor === 'light' ? 4 : 6);
}

export function seatsUsed(world: World, c: Entity): number {
  let n = 0;
  for (const id of c.cargo) {
    const u = world.entities.get(id);
    if (u) n += seatsOf(u);
  }
  return n;
}

/** Riding in a transport (not garrisoning a building): hidden and can't fire. */
export function isPassenger(world: World, e: Entity): boolean {
  if (!e.inside) return false;
  return world.entities.get(e.inside)?.kind === 'unit';
}

/** Whether `u` may get into `c` right now. */
export function canEnter(world: World, u: Entity, c: Entity): boolean {
  if (u === c || u.kind !== 'unit' || u.dead || u.inside || u.domain !== 'ground' || u.unit?.logistics) return false;
  if (c.dead || c.capacity <= 0 || c.buildProgress < 1 || c.inside) return false;
  if (c.kind === 'structure') {
    if (u.armor !== 'infantry') return false;
    // Neutral ruins: anyone may take an empty one; occupied ones belong to the occupier's team.
    if (c.owner !== NEUTRAL && c.team !== u.team) return false;
  } else {
    if (c.team !== u.team) return false;
    if (!c.unit?.transport?.carries.includes(u.armor)) return false;
  }
  return seatsUsed(world, c) + seatsOf(u) <= c.capacity;
}

/** `enter` command: units walk to the transport/building and board. */
export function orderEnter(world: World, units: Entity[], target: Entity, queue: boolean, give: (e: Entity) => void): Entity[] {
  const ok = units.filter((u) => u !== target && u.domain === 'ground' && !u.inside && (canEnter(world, u, target) || queue));
  for (const u of ok) give(u);
  return ok;
}

function dist2(a: Vec2, b: Vec2): number {
  return (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
}

/** How close a unit must get to board. Ships wait offshore, so infantry board from the beach. */
function boardReach(u: Entity, c: Entity): number {
  return c.radius + u.radius + (c.domain === 'naval' ? 18 : c.domain === 'air' ? 6 : 3);
}

/** One tick of walking to a container and boarding it (movementSystem). */
export function enterTick(world: World, e: Entity, targetId: EntityId): void {
  const c = world.entities.get(targetId);
  if (!c || !canEnter(world, e, c)) {
    nextOrder(e);
    return;
  }
  const reach = boardReach(e, c);
  if (dist2(e.pos, c.pos) > reach * reach) {
    // Transports may be moving: refresh the path now and then.
    if (!e.path || (world.tick + e.id) % 20 === 0) setPath(world, e, c.pos);
    // The center of a building (or a ship) can't be reached: arriving at the nearest open spot counts.
    const arrived = followPath(world, e, reach * 0.8);
    if (!arrived || dist2(e.pos, c.pos) > (reach + 10) * (reach + 10)) return;
  }
  board(world, e, c);
}

export function board(world: World, u: Entity, c: Entity): void {
  if (u.line) leaveLine(world, u);
  packUp(u);
  u.entrench = 'none';
  u.ambush = false;
  u.inside = c.id;
  u.order = null;
  u.orderQueue.length = 0;
  u.path = null;
  u.target = 0;
  u.guard = null;
  u.moving = false;
  u.pos.x = c.pos.x;
  u.pos.z = c.pos.z;
  c.cargo.push(u.id);
  if (c.kind === 'structure' && c.owner === NEUTRAL) {
    c.owner = u.owner;
    c.team = u.team;
  }
  world.emit({ type: 'boarded', id: u.id, container: c.id, entered: true });
}

/** `unload` command: buildings empty at once, transports drive/fly/sail to `at` first. */
export function orderUnload(world: World, player: PlayerId, ids: EntityId[], at: Vec2 | undefined, queue: boolean): EntityId[] {
  const done: EntityId[] = [];
  for (const id of ids) {
    const c = world.entities.get(id);
    if (!c || c.dead || !c.cargo.length) continue;
    // Garrisons: the occupier's player (or co-commander) may empty a building.
    const owner = c.kind === 'structure' ? world.entities.get(c.cargo[0])?.owner ?? c.owner : c.owner;
    if (owner !== player && !(c.owner >= 0 && canCommand(world, player, c))) continue;
    if (c.kind === 'structure' || !at) {
      if (c.kind === 'structure' || !queue) {
        ejectAll(world, c, false);
        done.push(id);
        continue;
      }
    }
    const order = { kind: 'unload' as const, at: at ? { x: at.x, z: at.z } : null };
    if (queue && c.order) c.orderQueue.push(order);
    else {
      c.order = order;
      c.orderQueue.length = 0;
      c.path = null;
      c.target = 0;
      c.guard = null;
    }
    done.push(id);
  }
  return done;
}

/** One tick of a transport heading to its drop point (movementSystem). */
export function unloadTick(world: World, c: Entity, at: Vec2 | null): void {
  if (!c.cargo.length) {
    nextOrder(c);
    return;
  }
  if (at) {
    if (!c.path) setPath(world, c, at);
    const arrived = followPath(world, c, c.domain === 'air' ? 2 : 4);
    // Ships stop at the beach: close enough once land is within reach.
    const nearShore = c.domain === 'naval' && dist2(c.pos, at) < 60 * 60 && dropSpot(world, c, world.entities.get(c.cargo[0])!) !== null;
    if (!arrived && !nearShore) return;
  }
  ejectAll(world, c, false);
  nextOrder(c);
}

/** Free ground near a container to put a passenger down, searched in rings (deterministic). */
function dropSpot(world: World, c: Entity, u: Entity): Vec2 | null {
  const nav = world.nav;
  const start = c.radius + u.radius + 2;
  const maxR = c.domain === 'naval' ? 45 : start + 24;
  for (let r = start; r <= maxR; r += 3) {
    const steps = Math.max(8, Math.round(r));
    for (let k = 0; k < steps; k++) {
      // Start behind the container (doors/ramps are at the back) and alternate sides.
      const a = c.heading + PI + (k % 2 === 0 ? 1 : -1) * Math.floor((k + 1) / 2) * (TWO_PI / steps);
      const p = { x: c.pos.x + dsin(a) * r, z: c.pos.z + dcos(a) * r };
      if (nav.inBounds(p) && nav.passableAt(p, 'ground')) return p;
    }
  }
  return null;
}

/**
 * Everyone out. A destroyed aircraft or ship takes its passengers with it; a destroyed IFV or building
 * throws them out hurt. Passengers that can't find ground stay aboard (ships far from shore).
 */
export function ejectAll(world: World, c: Entity, destroyed: boolean): void {
  const keep: EntityId[] = [];
  for (const id of c.cargo) {
    const u = world.entities.get(id);
    if (!u || u.dead) continue;
    if (destroyed && c.kind === 'unit' && c.domain !== 'ground') {
      u.inside = 0;
      u.dead = true;
      u.hp = 0;
      u.killer = c.killer;
      continue;
    }
    const spot = dropSpot(world, c, u);
    if (!spot) {
      if (destroyed) {
        u.inside = 0;
        u.dead = true;
        u.hp = 0;
        u.killer = c.killer;
      } else keep.push(id);
      continue;
    }
    u.inside = 0;
    u.pos.x = spot.x;
    u.pos.z = spot.z;
    u.guard = { x: spot.x, z: spot.z };
    u.order = null;
    u.path = null;
    if (destroyed) u.hp = Math.max(1, u.hp * 0.6);
    world.emit({ type: 'boarded', id: u.id, container: c.id, entered: false });
  }
  c.cargo = keep;
  if (!keep.length && c.kind === 'structure' && c.homeOwner === NEUTRAL && c.owner !== NEUTRAL) {
    c.owner = NEUTRAL;
    c.team = -1;
  }
}

/** Passengers ride along (their position follows the container); drop ids that are gone. */
export function cargoSystem(world: World): void {
  for (const c of world.entities.values()) {
    if (!c.cargo.length || c.dead) continue;
    let pruned = false;
    for (const id of c.cargo) {
      const u = world.entities.get(id);
      if (!u || u.dead || u.inside !== c.id) {
        pruned = true;
        continue;
      }
      u.pos.x = c.pos.x;
      u.pos.z = c.pos.z;
      u.moving = false;
    }
    if (pruned) {
      c.cargo = c.cargo.filter((id) => {
        const u = world.entities.get(id);
        return !!u && !u.dead && u.inside === c.id;
      });
      if (!c.cargo.length && c.kind === 'structure' && c.homeOwner === NEUTRAL && c.owner !== NEUTRAL) {
        c.owner = NEUTRAL;
        c.team = -1;
      }
    }
  }
}
