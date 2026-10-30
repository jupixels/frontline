import { SIM_HZ, TICK_SECONDS, type EntityId, type PlayerId, type Vec2 } from '../../shared/types';
import type { SimUnitDef, StructureDef } from '../content';
import { dcos, dsin, headingTo, turnToward } from '../math/dmath';
import { footprintSize, type Entity, type Player, type World } from '../world';
import { followPath, nextOrder, setPath } from './movement';

type BlockReason = 'supply' | 'cp' | 'requirements' | 'placement' | 'queueFull';

function block(world: World, player: PlayerId, reason: BlockReason): false {
  world.proposed.push({ type: 'blocked', player, reason });
  return false;
}

export function meetsRequirements(p: Player, requires: string[] | undefined, tier: number): boolean {
  if (tier > p.tier) return false;
  for (const r of requires ?? []) if (!p.structures.get(r)) return false;
  return true;
}

/** Unit types `factory` can produce right now. */
export function producible(world: World, factory: Entity): string[] {
  const p = world.players.get(factory.owner);
  const def = factory.structure;
  if (!p || !def?.produces || factory.buildProgress < 1) return [];
  return def.produces.filter((u) => {
    const ud = world.content.units[u];
    return ud && meetsRequirements(p, undefined, ud.tier);
  });
}

export function buildable(world: World, player: PlayerId): string[] {
  const p = world.players.get(player);
  if (!p) return [];
  const out: string[] = [];
  for (const [id, def] of Object.entries(world.content.structures)) {
    if (def.buildable !== false && meetsRequirements(p, def.requires, def.tier)) out.push(id);
  }
  return out;
}

function nearOwnStructure(world: World, player: PlayerId, at: Vec2): boolean {
  const r = world.content.rules.buildRadius;
  for (const e of world.entities.values()) {
    if (e.kind !== 'structure' || e.owner !== player || e.dead) continue;
    const dx = e.pos.x - at.x;
    const dz = e.pos.z - at.z;
    if (dx * dx + dz * dz <= r * r) return true;
  }
  return false;
}

export function canPlace(world: World, player: PlayerId, type: string, at: Vec2, rotation: number): boolean {
  const def = world.content.structures[type];
  if (!def) return false;
  const [w, d] = footprintSize(def, rotation);
  return world.nav.canPlace(at, w, d, def.placement === 'shore') && nearOwnStructure(world, player, at);
}

/**
 * `build` command from `player` (who may be a co-commander): the foundation belongs to and is paid
 * by the builder's owner. Blocked reasons are reported to the issuing player.
 */
export function orderBuild(world: World, player: PlayerId, builder: Entity, type: string, at: Vec2, rotation: number, queue: boolean): boolean {
  const owner = builder.owner;
  const p = world.players.get(owner)!;
  const def = world.content.structures[type];
  if (!builder.unit?.builder || !def || def.buildable === false) return false;
  // Resume an unfinished site of the same type at the same spot.
  for (const e of world.entities.values()) {
    if (e.kind === 'structure' && e.owner === owner && e.type === type && e.buildProgress < 1 && !e.dead) {
      const dx = e.pos.x - at.x;
      const dz = e.pos.z - at.z;
      if (dx * dx + dz * dz <= 4) {
        assignBuild(builder, e.id, queue);
        return true;
      }
    }
  }
  if (!meetsRequirements(p, def.requires, def.tier)) return block(world, player, 'requirements');
  if (!canPlace(world, owner, type, at, rotation)) return block(world, player, 'placement');
  if (p.supply < def.cost) return block(world, player, 'supply');
  p.supply -= def.cost;
  const site = world.spawnStructure(type, owner, at, rotation, false);
  world.proposed.push({ type: 'placed', id: site.id, builder: builder.id });
  assignBuild(builder, site.id, queue);
  return true;
}

function assignBuild(builder: Entity, siteId: EntityId, queue: boolean): void {
  const order = { kind: 'build' as const, siteId };
  if (queue && builder.order) builder.orderQueue.push(order);
  else {
    builder.order = order;
    builder.orderQueue.length = 0;
    builder.path = null;
  }
}

/** A builder may work on sites of its own player, or of a player it shares command with (co-op). */
export function canHelpBuild(world: World, builder: Entity, site: Entity): boolean {
  if (site.kind !== 'structure' || site.owner < 0) return false;
  if (site.owner === builder.owner) return true;
  return !!world.commandsFor.get(builder.owner)?.has(site.owner) || !!world.commandsFor.get(site.owner)?.has(builder.owner);
}

/** Idle engineers pick up unfinished friendly construction within this range. */
const AUTO_BUILD_RANGE = 28;
const AUTO_BUILD_SCAN_TICKS = 10;

/**
 * Idle builders (no order, on foot) look around every few ticks for an unfinished friendly site
 * and start on the nearest one. A player's own orders always take precedence: only order-less
 * builders are picked up, and any new order replaces the automatic one. Returns true if it started.
 */
export function autoBuild(world: World, e: Entity): boolean {
  if (e.order || e.inside || !e.unit?.builder || (world.tick + e.id) % AUTO_BUILD_SCAN_TICKS !== 0) return false;
  let best: Entity | null = null;
  let bestD = Infinity;
  world.spatial.query(e.pos.x, e.pos.z, AUTO_BUILD_RANGE + 20, (s) => {
    if (s.kind !== 'structure' || s.dead || s.buildProgress >= 1 || !canHelpBuild(world, e, s)) return;
    const dx = s.pos.x - e.pos.x;
    const dz = s.pos.z - e.pos.z;
    // Measured to the footprint edge, so big buildings count when you stand beside them.
    const d = Math.max(0, Math.sqrt(dx * dx + dz * dz) - s.radius);
    if (d > AUTO_BUILD_RANGE) return;
    if (d < bestD || (d === bestD && best && s.id < best.id)) {
      best = s;
      bestD = d;
    }
  });
  if (!best) return false;
  e.order = { kind: 'build', siteId: (best as Entity).id };
  e.orderQueue.length = 0;
  e.path = null;
  e.guard = null;
  return true;
}

/** One tick of a builder working its build order (called from movementSystem). */
export function builderTick(world: World, e: Entity, siteId: EntityId): void {
  const site = world.entities.get(siteId);
  if (!site || site.dead || site.buildProgress >= 1 || !canHelpBuild(world, e, site)) {
    nextOrder(e);
    return;
  }
  const dx = site.pos.x - e.pos.x;
  const dz = site.pos.z - e.pos.z;
  const reach = site.radius + e.radius + 3;
  if (dx * dx + dz * dz > reach * reach) {
    if (!e.path) setPath(world, e, site.pos);
    followPath(world, e, 1);
    return;
  }
  e.path = null;
  e.heading = turnToward(e.heading, headingTo(dx, dz), e.unit!.turnRate * TICK_SECONDS);
  const def = site.structure!;
  const total = Math.max(1, def.buildSeconds * SIM_HZ);
  site.buildProgress = Math.min(1, site.buildProgress + 1 / total);
  site.hp = Math.min(site.maxHp, site.hp + (site.maxHp * 0.9) / total);
  if (site.buildProgress >= 1) {
    world.emit({ type: 'built', id: site.id });
    nextOrder(e);
  }
}

/** `produce` command: queue `count` items, each paid up front by the factory's owner. */
export function orderProduce(world: World, player: PlayerId, factory: Entity, unit: string, count: number): void {
  const p = world.players.get(factory.owner)!;
  const ud = world.content.units[unit];
  if (!ud || factory.buildProgress < 1 || !factory.structure?.produces?.includes(unit)) return;
  if (!meetsRequirements(p, undefined, ud.tier)) {
    block(world, player, 'requirements');
    return;
  }
  const n = Math.max(1, Math.min(world.content.rules.maxQueue, Math.floor(count)));
  for (let i = 0; i < n; i++) {
    if (factory.queue.length >= world.content.rules.maxQueue) {
      block(world, player, 'queueFull');
      return;
    }
    if (p.supply < ud.cost) {
      block(world, player, 'supply');
      return;
    }
    p.supply -= ud.cost;
    factory.queue.push({ unit, progress: 0, total: Math.max(1, Math.round(ud.buildSeconds * SIM_HZ)), paid: ud.cost });
  }
}

export function orderCancel(world: World, factory: Entity, index: number): void {
  const i = Math.floor(index);
  if (i < 0 || i >= factory.queue.length) return;
  const [item] = factory.queue.splice(i, 1);
  world.players.get(factory.owner)!.supply += item.paid;
}

function depotOnNode(world: World, e: Entity): boolean {
  const r = world.content.rules.supplyNodeRadius;
  for (const n of world.content.map.supplyNodes ?? []) {
    const dx = n.x - e.pos.x;
    const dz = n.z - e.pos.z;
    if (dx * dx + dz * dz <= r * r) return true;
  }
  return false;
}

/** Spawn a finished squad at the factory's door and send it to the rally point. */
function deliver(world: World, factory: Entity, unit: string, def: SimUnitDef): void {
  const fwdX = dsin(factory.heading);
  const fwdZ = dcos(factory.heading);
  const door = { x: factory.pos.x + fwdX * (factory.radius + def.radius + 2), z: factory.pos.z + fwdZ * (factory.radius + def.radius + 2) };
  const n = def.squad ?? 1;
  const spawned: Entity[] = [];
  for (let i = 0; i < n; i++) {
    const side = (i - (n - 1) / 2) * def.radius * 3;
    const at = { x: door.x + fwdZ * side, z: door.z - fwdX * side };
    const u = world.spawnUnit(unit, factory.owner, at, factory.heading);
    spawned.push(u);
    world.emit({ type: 'produced', factory: factory.id, unit: u.id });
  }
  const rally = factory.rally ?? { x: door.x + fwdX * 12, z: door.z + fwdZ * 12 };
  spawned.forEach((u, i) => {
    const side = (i - (n - 1) / 2) * def.radius * 3;
    u.order = { kind: 'move', target: { x: rally.x + fwdZ * side, z: rally.z - fwdX * side }, attackMove: false };
  });
}

/** Resource bookkeeping, income, production queues, hospitals. */
export function economySystem(world: World): void {
  const rules = world.content.rules;
  for (const p of world.players.values()) {
    p.powerProduced = 0;
    p.powerUsed = 0;
    p.cp = 0;
    p.structures.clear();
  }
  // HQ income goes straight to the player. Depots and held points fill a local stock that
  // supply trucks carry home (logistics.ts).
  const income = new Map<PlayerId, number>();
  for (const e of world.entities.values()) {
    const p = world.players.get(e.owner);
    if (!p || e.dead) continue;
    if (e.kind === 'unit') p.cp += e.cp;
    else if (e.kind === 'point') {
      if (!p.defeated) e.stock = Math.min(rules.stockCap, e.stock + rules.pointIncome / SIM_HZ);
    } else if (e.kind === 'structure' && e.buildProgress >= 1) {
      const def = e.structure!;
      p.structures.set(e.type, (p.structures.get(e.type) ?? 0) + 1);
      if (def.power >= 0) p.powerProduced += def.power;
      else p.powerUsed -= def.power;
      if (!def.income || p.defeated) continue;
      if (e.type === 'supply_depot') {
        const rate = def.income * (depotOnNode(world, e) ? rules.supplyNodeMult : 1);
        e.stock = Math.min(rules.stockCap, e.stock + rate / SIM_HZ);
      } else income.set(p.id, (income.get(p.id) ?? 0) + def.income);
    }
  }
  // Comeback: teams behind on morale may field a bigger army (they still have to take points to stop the bleed).
  let leader = -Infinity;
  for (const t of world.teams.values()) if (!t.defeated && t.morale > leader) leader = t.morale;
  for (const p of world.players.values()) {
    p.power = p.powerProduced - p.powerUsed;
    const behind = Math.max(0, leader - (world.teams.get(p.team)?.morale ?? leader));
    const comeback = rules.cpComebackPer ? Math.min(rules.cpComebackMax ?? 0, Math.floor(behind / rules.cpComebackPer)) : 0;
    p.cpCap = Math.min(rules.cpMax, rules.baseCp + rules.cpPerPoint * p.pointsHeld) + comeback;
    let tier = 1;
    for (const [type, n] of p.structures) {
      const g = world.content.structures[type]?.grantsTier ?? 0;
      if (n > 0 && g > tier) tier = g;
    }
    if (tier >= 2 && world.seconds() >= rules.tier3UnlockSeconds) tier = 3;
    p.tier = tier;
    if (p.defeated) continue;
    const boost = Math.min(rules.incomeComebackMax ?? 0, (behind / 100) * (rules.incomeComebackPer100 ?? 0));
    p.supply += ((income.get(p.id) ?? 0) + (p.hadHq ? boost : 0)) / SIM_HZ;
  }

  for (const e of world.entities.values()) {
    if (e.kind !== 'structure' || e.dead || e.buildProgress < 1) continue;
    const p = world.players.get(e.owner);
    if (!p || p.defeated) continue;
    if (e.queue.length) produceTick(world, p, e);
    const heal = e.structure!.heal;
    if (heal && p.power >= 0) healTick(world, e, heal);
  }
}

function produceTick(world: World, p: Player, factory: Entity): void {
  const item = factory.queue[0];
  const def = world.content.units[item.unit];
  if (item.progress < item.total) {
    item.progress = Math.min(item.total, item.progress + (p.power < 0 ? world.content.rules.lowPowerProductionMult : 1));
    if (item.progress < item.total) return;
  }
  if (p.cp + def.cp > p.cpCap) {
    // Waits at 100% until CP frees up; report once per second.
    if (world.tick % SIM_HZ === factory.id % SIM_HZ) block(world, p.id, 'cp');
    return;
  }
  factory.queue.shift();
  p.cp += def.cp;
  deliver(world, factory, item.unit, def);
}

function healTick(world: World, e: Entity, heal: NonNullable<StructureDef['heal']>): void {
  const amount = heal.perSecond / SIM_HZ;
  world.spatial.query(e.pos.x, e.pos.z, heal.radius, (u) => {
    if (u.kind === 'unit' && u.team === e.team && u.armor === 'infantry' && !u.dead && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + amount);
  });
}
