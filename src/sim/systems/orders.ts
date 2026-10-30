import type { Domain } from '../../shared/data';
import type { EntityId, PlayerId, Vec2 } from '../../shared/types';
import type { AnyPlayerCommand, SimCommand } from '../contracts';
import { dcos, dsin } from '../math/dmath';
import { canCommand, type Entity, type Order, type World } from '../world';
import { orderAbility, packUp } from './abilities';
import { orderEnter, orderUnload } from './containers';
import { orderBuild, orderCancel, orderProduce } from './economy';
import { advanceLine, disbandLine, leaveLine, orderHoldLine } from './lines';
import { setPath } from './movement';
import { pauseVote } from './pause';
import { orderSuperweapon, superweaponSite } from './superweapon';
import { defeat } from './victory';
import { orderDemolish } from './demolish';

/**
 * Units in `ids` that exist and `player` may command, deduplicated, in the order given. Units riding in
 * a transport take no orders (unload them first); garrisons only take `stop`/`hold`.
 */
function ownedUnits(world: World, player: PlayerId, ids: EntityId[], allowInside = false): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<EntityId>();
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    const e = world.entities.get(id);
    if (e && e.kind === 'unit' && !e.dead && !e.unit?.logistics && (allowInside || !e.inside) && canCommand(world, player, e) && !seen.has(id)) {
      seen.add(id);
      out.push(e);
    }
  }
  return out;
}

function ownedStructure(world: World, player: PlayerId, id: EntityId): Entity | undefined {
  const e = world.entities.get(id);
  return e && e.kind === 'structure' && !e.dead && canCommand(world, player, e) ? e : undefined;
}

export function giveOrder(e: Entity, order: Order, queue: boolean | undefined): void {
  // Entrenched infantry pack up before acting on a new order.
  if (order.kind !== 'hold' && !(queue && e.order)) packUp(e);
  // A frontline order never finishes, so queueing behind it means replacing it.
  if (e.order?.kind === 'line') queue = false;
  if (queue && e.order) e.orderQueue.push(order);
  else {
    e.order = order;
    e.orderQueue.length = 0;
    e.path = null;
    e.target = 0;
  }
  e.guard = null;
}

function finite(v: Vec2 | undefined): v is Vec2 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.z);
}

/** Spread a group around the target in a square grid so units don't all aim for one point. */
export function formationSlots(units: Entity[], target: Vec2): Vec2[] {
  const cols = Math.ceil(Math.sqrt(units.length));
  let spacing = 0;
  for (const u of units) spacing = Math.max(spacing, u.radius * 2.5);
  const half = (cols - 1) / 2;
  return units.map((_, i) => ({
    x: target.x + ((i % cols) - half) * spacing,
    z: target.z + (Math.floor(i / cols) - half) * spacing,
  }));
}

/** Units given a normal order leave their frontline. */
function detach(world: World, units: Entity[]): void {
  for (const u of units) if (u.line) leaveLine(world, u);
}

/** Move order for a group: one formation and one shared flow field per movement domain. */
function groupMove(world: World, units: Entity[], target: Vec2, attackMove: boolean, queue: boolean | undefined, facing?: number): void {
  const domains: Domain[] = ['ground', 'naval', 'air'];
  for (const d of domains) {
    const group = units.filter((u) => u.domain === d);
    if (!group.length) continue;
    const slots = (facing === undefined ? formationSlots(group, target) : facedSlots(group, target, facing)).map((s) => world.nav.snap(s, d));
    group.forEach((u, i) => {
      const wasIdle = !u.order || !queue || u.order.kind === 'line';
      giveOrder(u, { kind: 'move', target: slots[i], attackMove }, queue);
      if (wasIdle) setPath(world, u, slots[i], target);
    });
  }
}

/** Right-drag formation: a line abreast perpendicular to `facing`, two ranks for big groups. */
function facedSlots(units: Entity[], target: Vec2, facing: number): Vec2[] {
  let spacing = 0;
  for (const u of units) spacing = Math.max(spacing, u.radius * 2.6);
  const perRank = units.length > 8 ? Math.ceil(units.length / 2) : units.length;
  const fx = dsin(facing);
  const fz = dcos(facing);
  return units.map((_, i) => {
    const rank = Math.floor(i / perRank);
    const n = Math.min(perRank, units.length - rank * perRank);
    const side = ((i % perRank) - (n - 1) / 2) * spacing;
    return { x: target.x + fz * side - fx * rank * spacing, z: target.z - fx * side - fz * rank * spacing };
  });
}

/** Patrol: each unit walks between where it stands and its slot around `target`. */
function groupPatrol(world: World, units: Entity[], target: Vec2, queue: boolean | undefined): void {
  const domains: Domain[] = ['ground', 'naval', 'air'];
  for (const d of domains) {
    const group = units.filter((u) => u.domain === d);
    if (!group.length) continue;
    const slots = formationSlots(group, target).map((s) => world.nav.snap(s, d));
    group.forEach((u, i) => {
      const from = queue && u.order?.kind === 'move' ? u.order.target : u.pos;
      giveOrder(u, { kind: 'patrol', a: { x: from.x, z: from.z }, b: slots[i], toB: true }, queue);
      if (!queue || !u.order) setPath(world, u, slots[i], target);
    });
  }
}

export function applyCommands(world: World, commands: readonly AnyPlayerCommand[]): void {
  for (const pc of commands) {
    const player = pc.player;
    const cmd = pc.cmd as SimCommand;
    const p = world.players.get(player);
    if (!p || p.defeated || world.over || !cmd) continue;
    // While paused only votes (and surrender) go through.
    if (world.paused && cmd.type !== 'pauseVote' && cmd.type !== 'surrender') continue;
    switch (cmd.type) {
      case 'move': {
        const units = ownedUnits(world, player, cmd.units);
        if (units.length === 0 || !finite(cmd.target)) break;
        detach(world, units);
        const facing = typeof cmd.facing === 'number' && Number.isFinite(cmd.facing) ? cmd.facing : undefined;
        groupMove(world, units, cmd.target, !!cmd.attackMove, cmd.queue, facing);
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'move' });
        break;
      }
      case 'patrol': {
        const units = ownedUnits(world, player, cmd.units);
        if (units.length === 0 || !finite(cmd.target)) break;
        detach(world, units);
        groupPatrol(world, units, cmd.target, cmd.queue);
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'patrol' });
        break;
      }
      case 'attack': {
        const units = ownedUnits(world, player, cmd.units);
        const t = world.entities.get(cmd.targetId);
        if (units.length === 0 || !t || t.dead || t.kind === 'point') break;
        detach(world, units);
        for (const u of units) giveOrder(u, { kind: 'attack', targetId: cmd.targetId }, cmd.queue);
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'attack' });
        break;
      }
      case 'enter': {
        const units = ownedUnits(world, player, cmd.units);
        const t = world.entities.get(cmd.target);
        if (!units.length || !t || t.dead) break;
        detach(world, units);
        const ok = orderEnter(world, units, t, !!cmd.queue, (u) => giveOrder(u, { kind: 'enter', targetId: t.id }, cmd.queue));
        if (ok.length) world.emit({ type: 'ordered', player, units: ok.map((u) => u.id), order: 'enter' });
        break;
      }
      case 'unload': {
        if (!Array.isArray(cmd.units) || (cmd.at !== undefined && !finite(cmd.at))) break;
        const done = orderUnload(world, player, cmd.units, cmd.at, !!cmd.queue);
        if (done.length) world.emit({ type: 'ordered', player, units: done, order: 'unload' });
        break;
      }
      case 'holdLine': {
        const units = ownedUnits(world, player, cmd.units);
        const line = orderHoldLine(world, player, units, cmd.points, typeof cmd.line === 'number' ? cmd.line : undefined);
        if (line) world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'line' });
        break;
      }
      case 'advanceLine':
        if (typeof cmd.line === 'number') advanceLine(world, player, cmd.line, cmd.distance);
        break;
      case 'disbandLine':
        if (typeof cmd.line === 'number') disbandLine(world, player, cmd.line);
        break;
      case 'superweapon': {
        if (!finite(cmd.at)) break;
        // Co-commanders fire their army's missile, if their role covers the launch site.
        const army = world.armyOf.get(player) ?? player;
        const site = superweaponSite(world, army);
        if (site && !canCommand(world, player, site)) world.emit({ type: 'blocked', player, reason: 'requirements' });
        else orderSuperweapon(world, army, cmd.at);
        break;
      }
      case 'pauseVote':
        pauseVote(world, player, !!cmd.paused);
        break;
      case 'stop': {
        const units = ownedUnits(world, player, cmd.units, true);
        detach(world, units);
        for (const u of units) {
          u.order = null;
          u.orderQueue.length = 0;
          u.path = null;
          u.target = 0;
          u.guard = { x: u.pos.x, z: u.pos.z };
        }
        if (units.length) world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'stop' });
        break;
      }
      case 'hold': {
        const units = ownedUnits(world, player, cmd.units, true);
        detach(world, units);
        for (const u of units) giveOrder(u, { kind: 'hold' }, false);
        if (units.length) world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'hold' });
        break;
      }
      case 'build': {
        const [builder] = ownedUnits(world, player, [cmd.builder]);
        if (!builder || !finite(cmd.at) || typeof cmd.structure !== 'string') break;
        const rot = Number.isFinite(cmd.rotation) ? cmd.rotation : 0;
        if (orderBuild(world, player, builder, cmd.structure, cmd.at, rot, !!cmd.queue)) {
          world.emit({ type: 'ordered', player, units: [builder.id], order: 'build' });
        }
        break;
      }
      case 'produce': {
        const f = ownedStructure(world, player, cmd.factory);
        if (f && typeof cmd.unit === 'string' && Number.isFinite(cmd.count)) orderProduce(world, player, f, cmd.unit, cmd.count);
        break;
      }
      case 'cancelProduce': {
        const f = ownedStructure(world, player, cmd.factory);
        if (f && Number.isFinite(cmd.index)) orderCancel(world, f, cmd.index);
        break;
      }
      case 'setRally': {
        const f = ownedStructure(world, player, cmd.factory);
        if (f && finite(cmd.at)) f.rally = { x: cmd.at.x, z: cmd.at.z };
        break;
      }
      case 'useAbility': {
        const units = ownedUnits(world, player, cmd.units);
        if (!units.length || typeof cmd.ability !== 'string') break;
        if (cmd.at !== undefined && !finite(cmd.at)) break;
        // Self abilities (sprint, entrench) keep a unit on its line; aimed ones take it off.
        if (world.content.abilities[cmd.ability]?.target !== 'self') detach(world, units);

        orderAbility(world, player, units, cmd.ability, cmd.at, cmd.targetId, !!cmd.queue);
        break;
      }
      case 'demolish':
        orderDemolish(world, player, cmd.structures);
        break;
      case 'surrender':
        defeat(world, player);
        break;
      default:
        break;
    }
  }
}
