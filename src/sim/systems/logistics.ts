import { SIM_HZ, type PlayerId, type TeamId, type Vec2 } from '../../shared/types';
import { dcos, dsin } from '../math/dmath';
import type { Entity, World } from '../world';
import { followPath, setPath } from './movement';

const TRUCK = 'supply_truck';

/** Owned capture points and completed supply depots generate supply into a local stock. */
export function isSupplySource(e: Entity): boolean {
  if (e.dead || e.owner < 0) return false;
  if (e.kind === 'point') return true;
  return e.kind === 'structure' && e.type === 'supply_depot' && e.buildProgress >= 1;
}

function hqOf(world: World, owner: PlayerId): Entity | undefined {
  for (const e of world.entities.values()) if (e.kind === 'structure' && e.type === 'hq' && e.owner === owner && !e.dead) return e;
  return undefined;
}

function reach(e: Entity): number {
  return e.kind === 'point' ? 6 : e.radius + 4;
}

function near(a: Vec2, b: Entity, r: number): boolean {
  const dx = a.x - b.pos.x;
  const dz = a.z - b.pos.z;
  return dx * dx + dz * dz <= r * r;
}

/**
 * Keeps one supply truck per source: a truck that dies is replaced from the HQ after
 * `truckRespawnSeconds`, so cutting a line starves that source until the road is safe again.
 */
export function logisticsSystem(world: World): void {
  const rules = world.content.rules;
  const hqs = new Map<PlayerId, Entity | undefined>();
  for (const src of world.entities.values()) {
    if (!isSupplySource(src)) continue;
    const p = world.players.get(src.owner);
    if (!p || p.defeated) continue;
    if (src.truck) {
      const t = world.entities.get(src.truck);
      if (t && !t.dead && t.owner === src.owner) continue;
      src.truck = 0;
      src.truckReadyAt = world.tick + rules.truckRespawnSeconds * SIM_HZ;
    }
    if (world.tick < src.truckReadyAt) continue;
    if (!hqs.has(src.owner)) hqs.set(src.owner, hqOf(world, src.owner));
    const hq = hqs.get(src.owner);
    if (!hq) continue;
    const fx = dsin(hq.heading);
    const fz = dcos(hq.heading);
    const door = { x: hq.pos.x + fx * (hq.radius + 4), z: hq.pos.z + fz * (hq.radius + 4) };
    const truck = world.spawnUnit(TRUCK, src.owner, door, hq.heading, 0);
    truck.haul = { source: src.id, phase: 'toSource', cargo: 0 };
    truck.guard = null;
    src.truck = truck.id;
  }
}

/** One tick of a truck's route (called from movementSystem; trucks can't be commanded). */
export function logisticsTick(world: World, truck: Entity): void {
  const h = truck.haul;
  const hq = hqOf(world, truck.owner);
  if (!h || !hq) return;
  const rules = world.content.rules;
  const src = world.entities.get(h.source);
  const srcOk = !!src && isSupplySource(src) && src.owner === truck.owner && src.truck === truck.id;
  if (h.phase === 'toSource') {
    if (!srcOk) {
      h.phase = 'toHq';
      truck.path = null;
      return;
    }
    if (!near(truck.pos, src, reach(src))) {
      if (!truck.path) setPath(world, truck, src.pos);
      followPath(world, truck, 2);
      return;
    }
    truck.path = null;
    // Wait for a worthwhile load.
    if (src.stock < rules.truckCapacity * 0.5) return;
    const take = Math.min(src.stock, rules.truckCapacity);
    src.stock -= take;
    h.cargo += take;
    h.phase = 'toHq';
    return;
  }
  if (!near(truck.pos, hq, reach(hq))) {
    if (!truck.path) setPath(world, truck, hq.pos);
    followPath(world, truck, 2);
    return;
  }
  truck.path = null;
  if (h.cargo > 0) {
    world.players.get(truck.owner)!.supply += h.cargo;
    world.proposed.push({ type: 'delivered', truck: truck.id, player: truck.owner, amount: h.cargo });
    h.cargo = 0;
  }
  // Source gone: the truck parks at the HQ and is retired.
  if (!srcOk) world.remove(truck.id);
  else h.phase = 'toSource';
}

/**
 * Readiness: units within `supplyRange` of a friendly HQ, supply depot or held point recover;
 * units beyond it slowly lose fire rate and accuracy. Each unit updates once per second.
 */
export function readinessSystem(world: World): void {
  const rules = world.content.rules;
  const nodes = new Map<TeamId, Vec2[]>();
  for (const e of world.entities.values()) {
    if (e.dead || e.team < 0) continue;
    if (!(e.type === 'hq' || isSupplySource(e)) || (e.kind === 'structure' && e.buildProgress < 1)) continue;
    let list = nodes.get(e.team);
    if (!list) nodes.set(e.team, (list = []));
    list.push(e.pos);
  }
  const r2 = rules.supplyRange * rules.supplyRange;
  for (const e of world.entities.values()) {
    if (e.kind !== 'unit' || e.dead || (world.tick + e.id) % SIM_HZ !== 0) continue;
    let supplied = false;
    for (const n of nodes.get(e.team) ?? []) {
      const dx = n.x - e.pos.x;
      const dz = n.z - e.pos.z;
      if (dx * dx + dz * dz <= r2) {
        supplied = true;
        break;
      }
    }
    e.readiness = supplied ? Math.min(1, e.readiness + rules.readinessRecoverPerSecond) : Math.max(rules.readinessMin, e.readiness - rules.readinessDecayPerSecond);
  }
}
