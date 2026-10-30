import type { RouteLeg, UnitRoute } from '../shared/entities';
import type { EntityId, Vec2 } from '../shared/types';
import type { Entity, Order, World } from './world';

/** Longest traced path, in flow-field steps. */
const MAX_STEPS = 600;

function orderLegs(world: World, o: Order, out: RouteLeg[]): void {
  const at = (id: EntityId): Vec2 | null => {
    const t = world.entities.get(id);
    return t && !t.dead ? { x: t.pos.x, z: t.pos.z } : null;
  };
  switch (o.kind) {
    case 'move':
      out.push({ kind: o.attackMove ? 'attackMove' : 'move', to: { x: o.target.x, z: o.target.z } });
      break;
    case 'patrol': {
      const [here, there] = o.toB ? [o.b, o.a] : [o.a, o.b];
      out.push({ kind: 'patrol', to: { x: here.x, z: here.z } }, { kind: 'patrol', to: { x: there.x, z: there.z } });
      break;
    }
    case 'attack':
    case 'enter': {
      const to = at(o.targetId);
      if (to) out.push({ kind: o.kind, to });
      break;
    }
    case 'build': {
      const to = at(o.siteId);
      if (to) out.push({ kind: 'build', to });
      break;
    }
    case 'unload':
      if (o.at) out.push({ kind: 'unload', to: { x: o.at.x, z: o.at.z } });
      break;
    case 'ability':
      out.push({ kind: 'ability', to: { x: o.at.x, z: o.at.z } });
      break;
  }
}

/**
 * Where a unit is headed: its current and queued legs, plus the route it will take on the current
 * one, read off its flow field. Read-only: never builds fields or touches sim state.
 */
export function unitRoute(world: World, e: Entity, trace = true): UnitRoute | null {
  if (e.dead || e.kind !== 'unit' || e.inside !== 0 || !e.order) return null;
  if (e.order.kind === 'line') return lineRoute(world, e);
  const legs: RouteLeg[] = [];
  orderLegs(world, e.order, legs);
  for (const o of e.orderQueue) orderLegs(world, o, legs);
  if (!legs.length) return null;
  const path: Vec2[] = [];
  const p = e.path;
  if (p) {
    const f = p.field;
    if (trace && f && !p.direct && e.domain !== 'air' && f.version === world.nav.version) {
      const grid = world.nav;
      const cols = grid.cols;
      let c = grid.cellOf(e.pos);
      let dx = 0;
      let dz = 0;
      if (f.reachable(c)) {
        for (let i = 0; i < MAX_STEPS; i++) {
          const n = f.next(c);
          if (n < 0) break;
          const ndx = (n % cols) - (c % cols);
          const ndz = Math.floor(n / cols) - Math.floor(c / cols);
          // Keep only the corners of the 8-direction staircase.
          if ((ndx !== dx || ndz !== dz) && i > 0) path.push({ x: grid.centerX(c % cols), z: grid.centerZ(Math.floor(c / cols)) });
          dx = ndx;
          dz = ndz;
          c = n;
        }
      }
    }
    path.push({ x: p.goal.x, z: p.goal.z });
    // The path ends at this unit's formation slot; the leg ends there too.
    if (legs[0].kind === 'move' || legs[0].kind === 'attackMove' || legs[0].kind === 'patrol') legs[0] = { kind: legs[0].kind, to: { x: p.goal.x, z: p.goal.z } };
  } else path.push(legs[0].to);
  return { legs, path };
}

/**
 * A frontline member: on the march, an attack-move leg from its slot to where that slot will be when
 * the line arrives; holding, a move leg to its slot while it's still walking there.
 */
function lineRoute(world: World, e: Entity): UnitRoute | null {
  const line = world.lines.get(e.line);
  const slot = e.lineSlot;
  if (!line || !slot) return null;
  const m = line.march;
  if (m) {
    const end = { x: slot.x + m.dx * m.left, z: slot.z + m.dz * m.left };
    return { legs: [{ kind: 'attackMove', to: end }], path: [{ x: slot.x, z: slot.z }, end] };
  }
  const dx = slot.x - e.pos.x;
  const dz = slot.z - e.pos.z;
  if (dx * dx + dz * dz < 9) return null;
  return { legs: [{ kind: 'move', to: { x: slot.x, z: slot.z } }], path: [{ x: slot.x, z: slot.z }] };
}
