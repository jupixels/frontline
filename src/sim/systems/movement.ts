import { TICK_SECONDS, type Vec2 } from '../../shared/types';
import { headingTo, turnToward, wrapAngle } from '../math/dmath';
import type { Entity, World } from '../world';
import { abilityOrderTick } from './abilities';
import { enterTick, unloadTick } from './containers';
import { autoBuild, builderTick } from './economy';
import { lineTick } from './lines';
import { logisticsTick } from './logistics';
import { terrainSpeed } from './terrain';
import { PINNED_SPEED } from './veterancy';

const ARRIVE_DIST = 0.75;
/** Vehicles only drive forward once roughly facing the target (radians). */
const DRIVE_CONE = 0.6;
/** How often a unit re-checks whether it can drive straight to its goal. */
const DIRECT_CHECK_TICKS = 8;
/** Flow-field lookahead in cells. */
const LOOKAHEAD = 3;
/** Largest radius any unit has; bounds the avoidance query. */
const MAX_RADIUS = 12;

export function nextOrder(e: Entity): void {
  e.order = e.orderQueue.shift() ?? null;
  e.path = null;
  e.chasing = false;
  if (!e.order) e.guard = { x: e.pos.x, z: e.pos.z };
}

/**
 * Point `e` at `goal`. Flow fields are built lazily, only once the straight line is blocked, and
 * toward `fieldGoal` (default `goal`) so a group shares one field.
 */
export function setPath(world: World, e: Entity, goal: Vec2, fieldGoal?: Vec2): void {
  const g = world.nav.snap(goal, e.domain);
  const fieldCell = e.domain === 'air' ? -1 : world.nav.cellOf(fieldGoal ? world.nav.snap(fieldGoal, e.domain) : g);
  e.path = { goal: g, field: null, fieldCell, direct: false, checkedAt: -DIRECT_CHECK_TICKS };
}

/** Where the unit should steer this tick to make progress toward its path goal. */
function steerPoint(world: World, e: Entity): Vec2 {
  const p = e.path!;
  if (e.domain === 'air') return p.goal;
  if (world.tick - p.checkedAt >= DIRECT_CHECK_TICKS) {
    p.direct = world.nav.clearLine(e.pos, p.goal, e.domain);
    // Stagger re-checks across units so they don't all land on the same tick.
    p.checkedAt = world.tick - ((world.tick + e.id) % DIRECT_CHECK_TICKS);
  }
  if (p.direct) return p.goal;
  if (!p.field || p.field.version !== world.nav.version) p.field = world.fields.get(e.domain, p.fieldCell);
  return p.field.lookahead(e.pos, LOOKAHEAD) ?? p.goal;
}

/** Drive one unit toward `to` for one tick. Returns the remaining distance. */
export function driveToward(world: World, e: Entity, to: Vec2, stopAt = ARRIVE_DIST): number {
  const def = e.unit!;
  const dx = to.x - e.pos.x;
  const dz = to.z - e.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= stopAt) return d;
  const want = headingTo(dx, dz);
  e.heading = turnToward(e.heading, want, def.turnRate * TICK_SECONDS);
  if (Math.abs(wrapAngle(want - e.heading)) > DRIVE_CONE) return d;
  let speed = world.tick < e.boostUntil ? def.speed * e.boostMult : def.speed;
  speed *= terrainSpeed(world, e, dx / d, dz / d);
  if (e.pinned) speed *= PINNED_SPEED;
  const step = Math.min(speed * TICK_SECONDS, d - stopAt * 0.5);
  if (step <= 0) return d;
  slide(world, e, (dx / d) * step, (dz / d) * step);
  e.moving = true;
  return d;
}

/** Move by (mx, mz), sliding along walls instead of entering impassable cells. */
function slide(world: World, e: Entity, mx: number, mz: number): void {
  const nav = world.nav;
  const nx = e.pos.x + mx;
  const nz = e.pos.z + mz;
  if (nav.passableAt({ x: nx, z: nz }, e.domain)) {
    e.pos.x = nx;
    e.pos.z = nz;
  } else if (nav.passableAt({ x: nx, z: e.pos.z }, e.domain)) {
    e.pos.x = nx;
  } else if (nav.passableAt({ x: e.pos.x, z: nz }, e.domain)) {
    e.pos.z = nz;
  }
}

/** Follow the current path. Returns true on arrival. */
export function followPath(world: World, e: Entity, stopAt = ARRIVE_DIST): boolean {
  const p = e.path!;
  const to = steerPoint(world, e);
  const isGoal = to === p.goal;
  const d = driveToward(world, e, to, isGoal ? stopAt : 0.5);
  if (isGoal && d <= stopAt) return true;
  // Stuck at an unreachable goal: close enough counts.
  if (!e.moving && isGoal && d <= stopAt + e.radius * 2 && !world.nav.passableAt(to, e.domain)) return true;
  return false;
}

/** Turret relaxes back to the hull heading when it has nothing to aim at. */
export function relaxTurret(e: Entity): void {
  if (e.turretHeading === undefined) return;
  const rate = e.unit?.turretTurnRate ?? 2;
  e.turretHeading = turnToward(e.turretHeading, e.heading, rate * TICK_SECONDS);
}

/** Moves units that have a move/build order and aren't busy fighting (combat.ts decides that). */
export function movementSystem(world: World): void {
  for (const e of world.entities.values()) {
    if (e.kind !== 'unit' || e.dead) continue;
    if (e.unit?.logistics) {
      logisticsTick(world, e);
      continue;
    }
    if (e.busy || e.inside) continue;
    // Entrenching / packing infantry can't move.
    if (e.entrench !== 'none') {
      e.path = null;
      continue;
    }
    if (e.chasing) {
      e.path = null;
      e.chasing = false;
    }
    const o = e.order;
    if (!o) {
      e.path = null;
      // Idle engineers lend a hand on unfinished buildings nearby.
      if (autoBuild(world, e)) builderTick(world, e, (e.order as { siteId: number }).siteId);
      continue;
    }
    if (o.kind === 'move') {
      if (!e.path) setPath(world, e, o.target);
      if (followPath(world, e)) nextOrder(e);
    } else if (o.kind === 'patrol') {
      const goal = o.toB ? o.b : o.a;
      if (!e.path) setPath(world, e, goal);
      if (followPath(world, e, 2)) {
        o.toB = !o.toB;
        e.path = null;
      }
    } else if (o.kind === 'line') {
      lineTick(world, e);
    } else if (o.kind === 'enter') {
      enterTick(world, e, o.targetId);
    } else if (o.kind === 'unload') {
      unloadTick(world, e, o.at);
    } else if (o.kind === 'ability') {
      abilityOrderTick(world, e, o);
    } else if (o.kind === 'build') {
      builderTick(world, e, o.siteId);
    } else if (o.kind === 'hold') {
      e.path = null;
    }
  }
}

/**
 * Local avoidance: push overlapping units of the same domain apart, using the spatial hash.
 * Moving units push idle ones harder so groups flow through parked units. Units that end up
 * inside an impassable cell (a structure was placed on them) are nudged out.
 */
export function avoidanceSystem(world: World): void {
  world.rebuildSpatial();
  const nav = world.nav;
  for (const a of world.entities.values()) {
    if (a.kind !== 'unit' || a.dead || a.inside) continue;
    let px = 0;

    let pz = 0;
    world.spatial.query(a.pos.x, a.pos.z, a.radius + MAX_RADIUS, (b, d2) => {
      if (b === a || b.kind !== 'unit' || b.domain !== a.domain || b.dead) return;
      const min = a.radius + b.radius;
      if (d2 >= min * min) return;
      let dx = a.pos.x - b.pos.x;
      let dz = a.pos.z - b.pos.z;
      let d = Math.sqrt(d2);
      if (d < 1e-6) {
        // Exactly stacked: split by id so both peers agree on the direction.
        dx = a.id < b.id ? -1 : 1;
        dz = 0;
        d = 1;
      }
      const overlap = min - d;
      // Moving units yield less than idle ones; heavier (bigger) units yield less than small ones.
      const share = (a.moving && !b.moving ? 0.25 : !a.moving && b.moving ? 0.75 : 0.5) * (b.radius / (a.radius + b.radius)) * 2;
      px += (dx / d) * overlap * Math.min(share, 1) * 0.5;
      pz += (dz / d) * overlap * Math.min(share, 1) * 0.5;
    });
    if (px !== 0 || pz !== 0) {
      const max = a.unit!.speed * TICK_SECONDS;
      const m = Math.sqrt(px * px + pz * pz);
      if (m > max) {
        px = (px / m) * max;
        pz = (pz / m) * max;
      }
      slide(world, a, px, pz);
    }
    if (a.domain !== 'air' && !nav.passableAt(a.pos, a.domain)) {
      const c = nav.nearestPassable(a.pos, a.domain, 16);
      if (c >= 0) {
        const tx = nav.centerX(c % nav.cols);
        const tz = nav.centerZ(Math.floor(c / nav.cols));
        const dx = tx - a.pos.x;
        const dz = tz - a.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const step = Math.min(d, a.unit!.speed * TICK_SECONDS * 2);
        if (d > 0) {
          a.pos.x += (dx / d) * step;
          a.pos.z += (dz / d) * step;
        }
      }
    }
  }
}
