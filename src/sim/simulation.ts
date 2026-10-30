import type { EntityState, FrontlineView, PauseView, PlayerState, SimView, SuperweaponView, UnitRoute } from '../shared/entities';
import { assignSpawns } from '../shared/maps';
import type { SimEvent } from '../shared/events';
import { SIM_HZ, type EntityId, type MatchSetup, type PlayerId, type TeamId, type Tick, type Vec2 } from '../shared/types';
import type { AnyPlayerCommand, EconomyView, FogView, ProductionView, ProposedEvent, SimViewExt } from './contracts';
import { dcos, dsin, headingTo } from './math/dmath';
import { StateHasher } from './math/hash';
import { unitRoute } from './route';
import { abilitySystem } from './systems/abilities';
import { deathSystem, projectileSystem, targetingSystem, weaponsSystem } from './systems/combat';
import { buildable, canPlace, economySystem, producible } from './systems/economy';
import { logisticsSystem, readinessSystem } from './systems/logistics';
import { avoidanceSystem, movementSystem } from './systems/movement';
import { applyCommands } from './systems/orders';
import { canEnter, cargoSystem } from './systems/containers';
import { lineSystem } from './systems/lines';
import { pauseSystem, votesNeeded } from './systems/pause';
import { superweaponStatus, superweaponSystem } from './systems/superweapon';
import { veterancySystem } from './systems/veterancy';
import { captureSystem, victorySystem } from './systems/victory';
import { canCommand, World, type SimContent } from './world';

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

  /** Steps taken (lockstep turn clock); keeps counting while paused. */
  get tick(): Tick {
    return this.world.steps;
  }

  /** Game time in ticks; stands still while paused. */
  get gameTick(): Tick {
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

  /**
   * Advance one tick, applying `commands` first. Returns the events of this tick.
   * Accepts the shared PlayerCommand plus proposed sim commands (useAbility).
   */
  step(commands: readonly AnyPlayerCommand[]): SimEvent[] {
    const w = this.world;
    w.events = [];
    w.proposed = [];
    applyCommands(w, commands);
    pauseSystem(w);
    w.steps++;
    if (w.paused) {
      this.proposedEvents = w.proposed;
      return w.events;
    }
    if (w.tick % w.content.rules.fogUpdateTicks === 0) w.fog.update();
    targetingSystem(w);
    movementSystem(w);
    avoidanceSystem(w);
    cargoSystem(w);
    lineSystem(w);
    weaponsSystem(w);
    projectileSystem(w);
    abilitySystem(w);
    veterancySystem(w);
    superweaponSystem(w);
    economySystem(w);
    logisticsSystem(w);
    readinessSystem(w);
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
    h.num(w.tick).num(w.steps).num(w.paused ? 1 : 0).num(w.pauseVotes.length);
    for (const n of w.rng.state()) h.num(n);
    for (const t of w.teams.values()) h.num(t.id).num(t.morale).num(t.defeated ? 1 : 0).num(t.moraleLow ? 1 : 0);
    for (const p of w.players.values()) h.num(p.id).num(p.supply).num(p.power).num(p.morale).num(p.defeated ? 1 : 0).num(p.cp).num(p.tier).num(p.superCharge).num(p.pausesLeft);
    for (const e of w.entities.values()) {
      h.num(e.id).str(e.type).num(e.owner).num(e.pos.x).num(e.pos.z).num(e.heading).num(e.hp);
      h.num(e.target).num(e.buildProgress).num(e.captureProgress).num(e.capturer);
      if (e.turretHeading !== undefined) h.num(e.turretHeading);
      for (const wp of e.weapons) h.num(wp.cooldown);
      for (const q of e.queue) h.str(q.unit).num(q.progress);
      for (const a of e.abilities) h.num(a.cooldown);
      h.str(e.entrench).num(e.entrenchAt).num(e.boostUntil).num(e.ambush ? 1 : 0).num(e.readiness).num(e.stock).num(e.truck).num(e.truckReadyAt);
      if (e.haul) h.num(e.haul.source).str(e.haul.phase).num(e.haul.cargo);
      h.num(e.inside).num(e.firedAt).num(e.cargo.length).num(e.suppression).num(e.xp).num(e.rank).num(e.maxHp).num(e.line);
      if (e.lineSlot) h.num(e.lineSlot.x).num(e.lineSlot.z);
    }
    for (const l of w.lines.values()) {
      h.num(l.id).num(l.owner).num(l.facing).num(l.units.length);
      for (const p of l.points) h.num(p.x).num(p.z);
    }
    for (const m of w.missiles) h.num(m.player).num(m.at.x).num(m.at.z).num(m.arrive);
    for (const p of w.projectiles) h.num(p.shooter).num(p.at.x).num(p.at.z).num(p.arrive).num(p.hits ? 1 : 0).num(p.mult);
    for (const s of w.smokes) h.num(s.at.x).num(s.at.z).num(s.until);
    for (const b of w.barrages) h.num(b.caster).num(b.left).num(b.next);
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
      morale: p.morale,
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

  abilities(id: EntityId): readonly { ability: string; cooldown: number; active: boolean }[] {
    const e = this.world.entities.get(id);
    if (!e) return [];
    return e.abilities.map((a) => ({
      ability: a.id,
      cooldown: a.def.cooldown > 0 ? a.cooldown / (a.def.cooldown * SIM_HZ) : 0,
      active:
        (a.id === 'entrench' && e.entrench !== 'none') ||
        (a.id === 'ambush' && e.ambush) ||
        (!!a.def.speedMult && this.world.tick < e.boostUntil) ||
        (e.order?.kind === 'ability' && e.order.ability === a.id) ||
        this.world.barrages.some((b) => b.caster === id && a.id === 'barrage'),
    }));
  }

  readiness(id: EntityId): number {
    return this.world.entities.get(id)?.readiness ?? 1;
  }

  stock(id: EntityId): number {
    return this.world.entities.get(id)?.stock ?? 0;
  }

  canCommand(player: PlayerId, id: EntityId): boolean {
    const e = this.world.entities.get(id);
    return !!e && canCommand(this.world, player, e);
  }

  route(id: EntityId, trace = true): UnitRoute | null {
    const e = this.world.entities.get(id);
    return e ? unitRoute(this.world, e, trace) : null;
  }

  lines(player: PlayerId): readonly FrontlineView[] {
    const team = this.world.teamOf(player);
    const out: FrontlineView[] = [];
    for (const l of this.world.lines.values()) if (l.team === team) out.push(l);
    return out;
  }

  superweapon(player: PlayerId): SuperweaponView | null {
    return superweaponStatus(this.world, player);
  }

  get pause(): PauseView {
    const w = this.world;
    const left: Record<number, number> = {};
    for (const p of w.players.values()) left[p.id] = p.pausesLeft;
    return { paused: w.paused, votes: w.pauseVotes, needed: votesNeeded(w), left };
  }

  heightAt(x: number, z: number): number {
    return this.world.heightAt(x, z);
  }

  canEnter(unit: EntityId, container: EntityId): boolean {
    const u = this.world.entities.get(unit);
    const c = this.world.entities.get(container);
    return !!u && !!c && canEnter(this.world, u, c);
  }

  reachable(domain: 'ground' | 'naval', a: Vec2, b: Vec2): boolean {
    return this.world.nav.reachable(domain, a, b);
  }

  private spawnMap(): void {
    const { map, rules } = this.world.content;
    for (const p of map.points ?? []) this.world.spawnPoint(p, p.radius ?? rules.pointRadius);
    for (const s of map.structures ?? []) {
      if (!this.world.content.structures[s.type]) continue;
      const quarter = 1.5707963267948966;
      this.world.spawnStructure(s.type, -1, { x: s.x, z: s.z }, Math.round((s.rotation ?? 0) / quarter) * quarter, true);
    }
  }

  private spawnStartingArmies(): void {
    const w = this.world;
    const { map } = w.content;
    const spawns = assignSpawns(map, w.setup.players);
    for (const slot of w.setup.players) {
      // Co-commanders share a teammate's army and start with nothing of their own.
      if (w.armyOf.has(slot.id)) continue;
      const spawn = map.spawns[spawns.get(slot.id) ?? slot.id % map.spawns.length];

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
