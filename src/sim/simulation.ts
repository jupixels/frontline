import type { PlayerCommand } from '../shared/commands';
import type { EntityState, PlayerState, SimView } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, MatchSetup, PlayerId, Tick } from '../shared/types';
import { headingTo } from './math/dmath';
import { StateHasher } from './math/hash';
import { applyCommands } from './systems/orders';
import { movementSystem, separationSystem } from './systems/movement';
import { World, type SimContent } from './world';

/** Starting army per player until production exists. */
const STARTING_UNITS = ['tank_mbt', 'tank_mbt', 'tank_mbt', 'ifv', 'jeep', 'rifleman', 'rifleman', 'rifleman'];

/**
 * The deterministic game simulation. Given the same MatchSetup, content and sequence of
 * turns, every peer computes bit-identical state. See CONTRIBUTING.md for the rules.
 */
export class Simulation implements SimView {
  readonly world: World;

  constructor(setup: MatchSetup, content: SimContent) {
    this.world = new World(setup, content);
    this.spawnStartingArmies();
    this.world.events.length = 0;
  }

  get tick(): Tick {
    return this.world.tick;
  }

  entities(): Iterable<EntityState> {
    return this.world.entities.values();
  }

  get(id: EntityId): EntityState | undefined {
    return this.world.entities.get(id);
  }

  player(id: PlayerId): PlayerState | undefined {
    return this.world.players.get(id);
  }

  /** Advance one tick, applying `commands` first. Returns the events of this tick. */
  step(commands: PlayerCommand[]): SimEvent[] {
    const w = this.world;
    w.events = [];
    applyCommands(w, commands);
    movementSystem(w);
    separationSystem(w);
    w.tick++;
    return w.events;
  }

  /** Hash of all gameplay state, compared between peers to detect desyncs. */
  hash(): number {
    const h = new StateHasher();
    const w = this.world;
    h.num(w.tick);
    for (const n of w.rng.state()) h.num(n);
    for (const p of w.players.values()) h.num(p.id).num(p.supply).num(p.power).num(p.tickets).num(p.defeated ? 1 : 0);
    for (const e of w.entities.values()) {
      h.num(e.id).str(e.type).num(e.owner).num(e.pos.x).num(e.pos.z).num(e.heading).num(e.hp);
      if (e.turretHeading !== undefined) h.num(e.turretHeading);
    }
    return h.digest();
  }

  private spawnStartingArmies(): void {
    const { map } = this.world.content;
    for (const slot of this.world.setup.players) {
      const spawn = map.spawns[slot.id % map.spawns.length];
      // Face the map center.
      const heading = headingTo(-spawn.x, -spawn.z);
      STARTING_UNITS.forEach((type, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        this.world.spawnUnit(type, slot.id, { x: spawn.x + (col - 1.5) * 9, z: spawn.z + row * 10 }, heading);
      });
    }
  }
}
