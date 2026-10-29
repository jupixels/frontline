import type { PlayerCommand } from '../../shared/commands';
import type { EntityId, PlayerId, Vec2 } from '../../shared/types';
import type { Entity, Order, World } from '../world';

/** Units in `ids` that exist and belong to `player`, in the order given. */
function ownedUnits(world: World, player: PlayerId, ids: EntityId[]): Entity[] {
  const out: Entity[] = [];
  for (const id of ids) {
    const e = world.entities.get(id);
    if (e && e.owner === player && e.kind === 'unit') out.push(e);
  }
  return out;
}

function giveOrder(e: Entity, order: Order, queue: boolean | undefined): void {
  if (queue && e.order) e.orderQueue.push(order);
  else {
    e.order = order;
    e.orderQueue.length = 0;
  }
}

/** Spread a group around the target in a square grid so units don't all aim for one point. */
function formationSlots(units: Entity[], target: Vec2): Vec2[] {
  const cols = Math.ceil(Math.sqrt(units.length));
  let spacing = 0;
  for (const u of units) spacing = Math.max(spacing, u.def.radius * 2.5);
  const half = (cols - 1) / 2;
  return units.map((_, i) => ({
    x: target.x + ((i % cols) - half) * spacing,
    z: target.z + (Math.floor(i / cols) - half) * spacing,
  }));
}

export function applyCommands(world: World, commands: PlayerCommand[]): void {
  for (const { player, cmd } of commands) {
    const p = world.players.get(player);
    if (!p || p.defeated) continue;
    switch (cmd.type) {
      case 'move': {
        const units = ownedUnits(world, player, cmd.units);
        if (units.length === 0) break;
        const slots = formationSlots(units, cmd.target);
        units.forEach((u, i) => giveOrder(u, { kind: 'move', target: slots[i], attackMove: !!cmd.attackMove }, cmd.queue));
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'move' });
        break;
      }
      case 'attack': {
        const units = ownedUnits(world, player, cmd.units);
        if (units.length === 0 || !world.entities.has(cmd.targetId)) break;
        for (const u of units) giveOrder(u, { kind: 'attack', targetId: cmd.targetId }, cmd.queue);
        world.emit({ type: 'ordered', player, units: units.map((u) => u.id), order: 'attack' });
        break;
      }
      case 'stop': {
        const units = ownedUnits(world, player, cmd.units);
        for (const u of units) {
          u.order = null;
          u.orderQueue.length = 0;
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
      case 'surrender':
        p.defeated = true;
        world.emit({ type: 'defeated', player });
        break;
      // build / produce / cancelProduce / setRally: implemented by the sim workstream.
      default:
        break;
    }
  }
}
