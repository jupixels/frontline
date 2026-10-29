import { TICK_SECONDS } from '../../shared/types';
import { headingTo, turnToward, wrapAngle } from '../math/dmath';
import type { Entity, World } from '../world';

const ARRIVE_DIST = 0.75;
/** Vehicles only drive forward once roughly facing the target (radians). */
const DRIVE_CONE = 0.6;

function nextOrder(e: Entity): void {
  e.order = e.orderQueue.shift() ?? null;
}

/**
 * Straight-line steering toward the current move order.
 * Phase 0 placeholder: the sim workstream replaces this with flow-field pathing + avoidance.
 */
export function movementSystem(world: World): void {
  for (const e of world.entities.values()) {
    e.moving = false;
    const o = e.order;
    if (!o || o.kind !== 'move') continue;

    const dx = o.target.x - e.pos.x;
    const dz = o.target.z - e.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= ARRIVE_DIST) {
      nextOrder(e);
      continue;
    }

    const want = headingTo(dx, dz);
    e.heading = turnToward(e.heading, want, e.def.turnRate * TICK_SECONDS);
    if (e.turretHeading !== undefined && e.def.turretTurnRate) {
      e.turretHeading = turnToward(e.turretHeading, e.heading, e.def.turretTurnRate * TICK_SECONDS);
    }
    if (Math.abs(wrapAngle(want - e.heading)) > DRIVE_CONE) continue;

    const step = Math.min(e.def.speed * TICK_SECONDS, d);
    e.pos.x += (dx / d) * step;
    e.pos.z += (dz / d) * step;
    e.moving = true;
  }
}

/** Push overlapping ground units apart. O(n^2) placeholder until spatial hashing lands. */
export function separationSystem(world: World): void {
  const units: Entity[] = [];
  for (const e of world.entities.values()) if (e.kind === 'unit') units.push(e);
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const min = a.def.radius + b.def.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      const nx = dx / d;
      const nz = dz / d;
      a.pos.x -= nx * push;
      a.pos.z -= nz * push;
      b.pos.x += nx * push;
      b.pos.z += nz * push;
    }
  }
}
