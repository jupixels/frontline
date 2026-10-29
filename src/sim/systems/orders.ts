import type { Domain } from '../../shared/data';
import type { EntityId, PlayerId, Vec2 } from '../../shared/types';
import type { AnyPlayerCommand, SimCommand } from '../contracts';
import { canCommand, type Entity, type Order, type World } from '../world';
import { orderAbility, packUp } from './abilities';
import { orderBuild, orderCancel, orderProduce } from './economy';
import { setPath } from './movement';
import { defeat } from './victory';

/** Units in `ids` that exist and `player` may command, deduplicated, in the order given. */
function ownedUnits(world: World, player: PlayerId, ids: EntityId[]): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<EntityId>();
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    const e = world.entities.get(id);
    if (e && e.kind === 'unit' && !e.dead && !e.unit?.logistics && canCommand(world, player, e) && !seen.has(id)) {
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

/** Move order for a group: one formation and one shared flow field per movement domain. */
function groupMove(world: World, units: Entity[], target: Vec2, attackMove: boolean, queue: boolean | undefined): void {
  const domains: Domain[] = ['ground', 'naval', 'air'];
  for (const d of domains) {
    const group = units.filter((u) => u.domain === d);
    if (!group.length) continue;
    const slots = formationSlots(group, target).map((s) => world.nav.snap(s, d));
    group.forEach((u, i) => {
      const wasIdle = !u.order || !queue;
      giveOrder(u, { kind: 'move', target: slots[i], attackMove }, queue);
      if (wasIdle) setPath(world, u, slots[i], target);
    });
  }
}

export function applyCommands(world: World, commands: readonly AnyPlayerCommand[]): void {
  for (const pc of commands) {
    const player = pc.player;
    const cmd = pc.cmd as SimCommand;
    const p = world.players.get(player);
    if (!p || p.defeated || world.over || !cmd) continue;
    switch (cmd.type) {
      case 'move': {
        const units = ownedUnits(world, player, cmd.units);
        if (units.length === 0 || !finite(cmd.target)) break;
        groupMove(world, units, cmd.target, !!cmd.attackMove, cmd.queue);
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'move' });
        break;
      }
      case 'attack': {
        const units = ownedUnits(world, player, cmd.units);
        const t = world.entities.get(cmd.targetId);
        if (units.length === 0 || !t || t.dead || t.kind === 'point') break;
        for (const u of units) giveOrder(u, { kind: 'attack', targetId: cmd.targetId }, cmd.queue);
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'attack' });
        break;
      }
      case 'stop': {
        const units = ownedUnits(world, player, cmd.units);
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
        const units = ownedUnits(world, player, cmd.units);
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
        orderAbility(world, player, units, cmd.ability, cmd.at, cmd.targetId, !!cmd.queue);
        break;
      }
      case 'surrender':
        defeat(world, player);
        break;
      default:
        break;
    }
  }
}
