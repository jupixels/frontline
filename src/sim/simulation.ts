import type { PlayerCommand } from '../shared/commands';
import type { EntityState, PlayerState, SimView } from '../shared/entities';
import type { SimEvent } from '../shared/events';
import type { EntityId, MatchSetup, PlayerId, TeamId, Tick, Vec2 } from '../shared/types';
import type { EconomyView, FogView, ProductionView, ProposedEvent, SimViewExt } from './contracts';
import { dcos, dsin, headingTo } from './math/dmath';
import { StateHasher } from './math/hash';
import { deathSystem, projectileSystem, targetingSystem, weaponsSystem } from './systems/combat';
import { buildable, canPlace, economySystem, producible } from './systems/economy';
import { avoidanceSystem, movementSystem } from './systems/movement';
import { applyCommands } from './systems/orders';
import { captureSystem, victorySystem } from './systems/victory';
import { World, type SimContent } from './world';

/** Starting army per player: HQ (spawned separately), an engineer and two rifle squads. */
const STARTING_UNITS: { type: string; count: number }[] = [
  { type: 'engineer', count: 1 },
  { type: 'rifleman', count: 4 },
  { type: 'rifleman', count: 4 },
];

/**
 * The deterministic game simulation. Given the same MatchSetup, content and sequence of
 * turns, every peer computes bit-identical state. See CONTRIBUTING.md for the rules.
 */
export class Simulation implements SimView, SimViewExt {
  readonly world: World;
  /** Events from the last step that aren't in the shared SimEvent union yet (see contracts.ts). */
  proposedEvents: ProposedEvent[] = [];

  constructor(setup: MatchSetup, content: SimContent) {
    this.world = new World(setup, content);
    this.spawnMap();
    this.spawnStartingArmies();
    this.world.events.length = 0;
    this.world.proposed.length = 0;
    economySystem(this.world);
    this.world.fog.update();
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
    w.proposed = [];
    applyCommands(w, commands);
    if (w.tick % w.content.rules.fogUpdateTicks === 0) w.fog.update();
    targetingSystem(w);
    movementSystem(w);
    avoidanceSystem(w);
    weaponsSystem(w);
    projectileSystem(w);
    economySystem(w);
    captureSystem(w);
    victorySystem(w);
    deathSystem(w);
    w.tick++;
    this.proposedEvents = w.proposed;
    return w.events;
  }

  /** Hash of all gameplay state, compared between peers to detect desyncs. */
  hash(): number {
    const h = new StateHasher();
    const w = this.world;
    h.num(w.tick);
    for (const n of w.rng.state()) h.num(n);
    for (const t of w.teams.values()) h.num(t.id).num(t.tickets).num(t.defeated ? 1 : 0);
    for (const p of w.players.values()) h.num(p.id).num(p.supply).num(p.power).num(p.tickets).num(p.defeated ? 1 : 0).num(p.cp).num(p.tier);
    for (const e of w.entities.values()) {
      h.num(e.id).str(e.type).num(e.owner).num(e.pos.x).num(e.pos.z).num(e.heading).num(e.hp);
      h.num(e.target).num(e.buildProgress).num(e.captureProgress).num(e.capturer);
      if (e.turretHeading !== undefined) h.num(e.turretHeading);
      for (const wp of e.weapons) h.num(wp.cooldown);
      for (const q of e.queue) h.str(q.unit).num(q.progress);
    }
    for (const p of w.projectiles) h.num(p.shooter).num(p.at.x).num(p.at.z).num(p.arrive).num(p.hits ? 1 : 0);
    return h.digest();
  }

  // --- SimViewExt (proposed shared read API) ---

  get fog(): FogView {
    return this.world.fog;
  }

  get winner(): TeamId | null {
    return this.world.winner;
  }

  economy(id: PlayerId): EconomyView | undefined {
    const p = this.world.players.get(id);
    if (!p) return undefined;
    return {
      team: p.team,
      supply: p.supply,
      power: p.power,
      powerProduced: p.powerProduced,
      powerUsed: p.powerUsed,
      cp: p.cp,
      cpCap: p.cpCap,
      tier: p.tier,
      pointsHeld: p.pointsHeld,
      tickets: p.tickets,
    };
  }

  queue(factory: EntityId): readonly ProductionView[] {
    const e = this.world.entities.get(factory);
    return e ? e.queue.map((q) => ({ unit: q.unit, progress: q.progress / q.total })) : [];
  }

  rally(factory: EntityId): Vec2 | null {
    return this.world.entities.get(factory)?.rally ?? null;
  }

  buildProgress(id: EntityId): number {
    return this.world.entities.get(id)?.buildProgress ?? 0;
  }

  capture(point: EntityId): { owner: PlayerId; capturer: PlayerId; progress: number; radius: number } | undefined {
    const e = this.world.entities.get(point);
    if (!e || e.kind !== 'point') return undefined;
    return { owner: e.owner, capturer: e.capturer, progress: e.captureProgress, radius: e.captureRadius };
  }

  producible(factory: EntityId): string[] {
    const e = this.world.entities.get(factory);
    return e ? producible(this.world, e) : [];
  }

  buildable(player: PlayerId): string[] {
    return buildable(this.world, player);
  }

  canPlace(player: PlayerId, structure: string, at: Vec2, rotation: number): boolean {
    return canPlace(this.world, player, structure, at, rotation);
  }

  private spawnMap(): void {
    const { map, rules } = this.world.content;
    for (const p of map.points ?? []) this.world.spawnPoint(p, p.radius ?? rules.pointRadius);
  }

  private spawnStartingArmies(): void {
    const w = this.world;
    const { map } = w.content;
    for (const slot of w.setup.players) {
      const spawn = map.spawns[slot.id % map.spawns.length];
      // Face the map center, snapped to 90 degrees so the footprint stays axis-aligned.
      const heading = headingTo(-spawn.x, -spawn.z);
      const quarter = 1.5707963267948966;
      const hqRot = Math.round(heading / quarter) * quarter;
      w.spawnStructure('hq', slot.id, spawn, hqRot, true);
      const fx = dsin(heading);
      const fz = dcos(heading);
      // Units line up in front of the HQ, one row per group.
      STARTING_UNITS.forEach((g, row) => {
        const def = w.content.units[g.type];
        for (let i = 0; i < g.count; i++) {
          const side = (i - (g.count - 1) / 2) * 2.5;
          const fwd = 22 + row * 4;
          const at = { x: spawn.x + fx * fwd + fz * side, z: spawn.z + fz * fwd - fx * side };
          w.spawnUnit(g.type, slot.id, at, heading, def.cp / g.count);
        }
      });
    }
  }
}
