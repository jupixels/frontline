// Skirmish AI. Plays like a player: it only issues Commands and only sees what its fog of war shows.
// Each think it (1) builds its base from a build plan, (2) keeps factories producing a mix that
// counters what it has seen, and (3) runs task forces that contest capture points: gather, attack
// (sometimes around a flank), take the point and hold it with a drawn frontline. Raiders hit supply
// trucks, depots and power; transports carry troops to islands; abilities and the superweapon fire
// when they pay off.

import type { Command } from '../shared/commands';
import type { MapDef } from '../shared/data';
import type { EntityState, SimView, SimViewExt } from '../shared/entities';
import { assignSpawns } from '../shared/maps';
import { SIM_HZ, type EntityId, type MatchSetup, type PlayerId, type TeamId, type Vec2 } from '../shared/types';
import { AI_PARAMS, type AiParams, type Difficulty } from './difficulty';
import { Knowledge, roleOf, STRUCTURE_DEFS, UNIT_DEFS, valueOf, type Role } from './knowledge';

type Sim = SimView & SimViewExt;

interface TaskForce {
  id: number;
  units: Set<EntityId>;
  /** Capture point it's after. */
  point: EntityId;
  state: 'gather' | 'attack' | 'hold' | 'retreat' | 'board' | 'ferry';
  since: number;
  ordersAt: number;
  /** Transport carrying it (amphibious / air assault). */
  transport: EntityId;
  lined: boolean;
}

/** Small seeded PRNG (the AI runs on one peer only, but tests want reproducible games). */
class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed * 2654435761) >>> 0 || 1;
  }
  next(): number {
    this.s ^= this.s << 13;
    this.s ^= this.s >>> 17;
    this.s ^= this.s << 5;
    return (this.s >>> 0) / 4294967296;
  }
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const centroid = (ps: Vec2[]): Vec2 => {
  let x = 0;
  let z = 0;
  for (const p of ps) {
    x += p.x;
    z += p.z;
  }
  return ps.length ? { x: x / ps.length, z: z / ps.length } : { x: 0, z: 0 };
};

/** Base mix per tier: relative weights of what to field. */
const BASE_MIX: Record<number, Record<string, number>> = {
  1: { rifleman: 3, at_soldier: 1.4, jeep: 0.6, scout_car: 1.2, patrol_boat: 1 },
  2: { rifleman: 2.2, at_soldier: 1.4, sniper: 0.4, scout_car: 0.5, ifv: 1.4, tank_light: 1, tank_mbt: 2, aa_tank: 0.5, artillery: 0.7, rocket_truck: 0.4, heli_attack: 1, destroyer: 1, submarine: 0.5, patrol_boat: 0.5 },
  3: { rifleman: 2, at_soldier: 1.4, sniper: 0.4, ifv: 1.2, tank_light: 0.8, tank_mbt: 2.2, aa_tank: 0.6, artillery: 0.8, rocket_truck: 0.5, heli_attack: 1.2, jet_fighter: 0.4, bomber: 0.2, destroyer: 1, submarine: 0.6, cruiser: 0.4 },
};

/** What to build more of when the enemy fields a lot of a role. */
const COUNTERS: Partial<Record<Role, Record<string, number>>> = {
  heavy: { at_soldier: 2.5, tank_mbt: 1.2, heli_attack: 1.5, ifv: 0.6 },
  light: { tank_light: 1.5, at_soldier: 1.2, tank_mbt: 0.6, scout_car: 0.6 },
  infantry: { ifv: 1.4, scout_car: 1.2, artillery: 1, rocket_truck: 0.8, rifleman: 0.6, sniper: 0.5 },
  antitank: { rifleman: 1.2, scout_car: 1, artillery: 0.8, sniper: 0.6 },
  artillery: { jeep: 1, scout_car: 1, heli_attack: 1.4 },
  aa: { tank_mbt: 1, at_soldier: 0.8, artillery: 0.6 },
  air: { aa_tank: 3, jet_fighter: 1.5 },
  naval: { destroyer: 1.5, submarine: 1.2, heli_attack: 0.8 },
};

const RAIDER_TYPES = new Set(['jeep', 'scout_car', 'heli_attack']);
/** Buildings worth holding production back for. */
const CORE = new Set(['barracks', 'war_factory', 'power_plant', 'supply_depot', 'radar']);

export class SkirmishAi {
  readonly difficulty: Difficulty;
  private readonly p: AiParams;
  private readonly k: Knowledge;
  private readonly rand: Rand;
  private readonly team: TeamId;
  private readonly spawn: Vec2;
  private readonly enemySpawns: Vec2[];
  private readonly naval: boolean;
  private nextThink = 0;
  private forces: TaskForce[] = [];
  private nextForceId = 1;
  private readonly assigned = new Map<EntityId, number>();
  private readonly engineerJobs = new Map<EntityId, { at: Vec2; type: string; since: number }>();
  private raiders = new Set<EntityId>();
  private scoutId: EntityId = 0;
  private scoutStep = 0;
  private readonly abilityAt = new Map<string, number>();
  private orders = 0;
  private thinks = 0;
  /** Supply held back for the next building in the plan. */
  private pendingBuild = 0;
  /** The unit production is saving up for, and since when. */
  private saveFor: { unit: string; since: number } | null = null;
  private engineerAt = -1e9;
  /** Outmatched at home: gathering at the HQ until strong enough to break out. */
  private turtling = false;
  /** Water spot near our base, if the map has sea within reach (naval yard / transport pickup). */
  private shore: Vec2 | null | undefined;

  constructor(
    readonly player: PlayerId,
    setup: MatchSetup,
    private readonly sim: Sim,
    private readonly map: MapDef,
    private readonly issue: (cmd: Command, player: PlayerId) => void,
    seed = 1,
  ) {
    const slot = setup.players.find((s) => s.id === player);
    this.difficulty = slot?.aiDifficulty ?? 'normal';
    this.p = AI_PARAMS[this.difficulty];
    this.rand = new Rand(seed * 7919 + player * 104729 + setup.seed);
    const teamOf = (pl: PlayerId) => setup.players.find((s) => s.id === pl)?.team ?? -1;
    this.team = teamOf(player);
    this.k = new Knowledge(player, sim, map, teamOf);
    const spawns = assignSpawns(map, setup.players);
    this.spawn = map.spawns[spawns.get(player) ?? 0];
    this.enemySpawns = setup.players.filter((s) => teamOf(s.id) !== this.team).map((s) => map.spawns[spawns.get(s.id) ?? 0]);
    this.naval = !!(map.terrain?.water?.length || map.water?.length);
    this.nextThink = this.rand.next() * this.p.think;
  }

  /** Game seconds (stops while paused). */
  private get now(): number {
    return (this.sim.gameTick ?? this.sim.tick) / SIM_HZ;
  }

  /** Call every frame (or every tick headless); it decides on its own schedule. */
  update(): void {
    const now = this.now;
    if (now < this.nextThink) return;
    this.nextThink = now + this.p.think * (0.85 + this.rand.next() * 0.3);
    if (this.sim.winner !== null && this.sim.winner !== undefined) return;
    const me = this.sim.player(this.player);
    if (!me || me.defeated) return;
    this.k.refresh(now);
    this.orders = 0;
    this.thinks++;
    if (now < this.p.startDelay) return;
    this.economy(now);
    this.production(now);
    this.military(now);
    if (this.p.abilities) this.useAbilities(now);
    if (this.p.superweapon) this.useSuperweapon();
  }

  private send(cmd: Command): void {
    this.orders++;
    this.issue(cmd, this.player);
  }

  // --- helpers ---

  private hq(): EntityState | undefined {
    return this.k.own.find((e) => e.type === 'hq');
  }

  private base(): Vec2 {
    return this.hq()?.pos ?? this.spawn;
  }

  private complete(e: EntityState): boolean {
    return e.kind !== 'structure' || this.sim.buildProgress(e.id) >= 1;
  }

  /** Where the enemy is: its remembered HQs, else the spawns enemies started at. */
  private enemyBase(): Vec2 {
    const hqs = this.k.enemyStructures().filter((s) => s.type === 'hq');
    const list = hqs.length ? hqs.map((s) => s.pos) : this.enemySpawns;
    const b = this.base();
    let best = list[0] ?? { x: -b.x, z: -b.z };
    for (const p of list) if (dist(p, b) < dist(best, b)) best = p;
    return best;
  }

  /** Free spot for a structure near `near` (rings outward), or null. */
  private findSpot(type: string, near: Vec2, minR = 25, maxR = 140): Vec2 | null {
    const a0 = this.rand.next() * Math.PI * 2;
    for (let r = minR; r <= maxR; r += 12) {
      const steps = Math.max(8, Math.round(r / 6));
      for (let i = 0; i < steps; i++) {
        const a = a0 + (i / steps) * Math.PI * 2;
        const at = { x: near.x + Math.cos(a) * r, z: near.z + Math.sin(a) * r };
        if (this.sim.canPlace(this.player, type, at, 0)) return at;
      }
    }
    return null;
  }

  /** Nearest deep-water spot within ~420 m of the base (cached), or null on land maps. */
  private shorePoint(): Vec2 | null {
    if (this.shore !== undefined) return this.shore;
    this.shore = null;
    if (!this.naval) return null;
    const b = this.spawn;
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (let r = 40; r <= 420; r += 20) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const p = { x: b.x + Math.cos(a) * r, z: b.z + Math.sin(a) * r };
        if (Math.abs(p.x) > this.map.size / 2 - 5 || Math.abs(p.z) > this.map.size / 2 - 5) continue;
        if (this.sim.heightAt(p.x, p.z) < -2 && r < bestD) {
          bestD = r;
          best = p;
        }
      }
      if (best) break;
    }
    this.shore = best;
    return best;
  }

  // --- economy ---

  /** The base this difficulty wants by now, in build order: [type, count]. */
  private buildPlan(now: number): [string, number][] {
    const p = this.p;
    const plan: [string, number][] = [
      ['barracks', 1],
      ['power_plant', 1],
      ['supply_depot', 1],
      ['war_factory', 1],
      ['power_plant', 2],
    ];
    if (p.depots >= 2) plan.push(['supply_depot', 2]);
    if (now >= p.radarAt) plan.push(['radar', 1]);
    if (this.difficulty !== 'easy') plan.push(['hospital', 1]);
    if (this.naval && this.shorePoint() && this.difficulty !== 'easy') plan.push(['naval_yard', 1]);
    if (now >= p.radarAt + 60) plan.push(['helipad', 1], ['power_plant', 3]);
    if (p.depots >= 3) plan.push(['supply_depot', 3]);
    if (now > (this.difficulty === 'hard' ? 600 : 900)) plan.push(['war_factory', 2], ['barracks', 2]);
    if (now >= p.strategicAt) plan.push(['power_plant', 4], ['strategic_command', 1]);
    if (now >= p.strategicAt + 120 && (this.k.enemyMix().mix.air > 0.15 || this.difficulty === 'hard')) plan.push(['airfield', 1]);
    return plan;
  }

  private economy(now: number): void {
    this.pendingBuild = 0;
    const eco = this.sim.economy(this.player);
    const hq = this.hq();
    if (!eco || !hq) return;
    const engineers = this.k.ownByType('engineer');
    // Keep the engineer count up.
    // (Replacements are rate-limited so engineers lost at the front don't drain the economy.)
    if (engineers.length < this.p.engineers && eco.supply > 150 && this.sim.queue(hq.id).length === 0 && now - this.engineerAt > 60) {
      this.send({ type: 'produce', factory: hq.id, unit: 'engineer', count: 1 });
      this.engineerAt = now;
    }
    // Finished or stale jobs free the engineer.
    for (const [id, job] of this.engineerJobs) {
      const e = this.sim.get(id);
      const site = this.k.own.find((s) => s.kind === 'structure' && s.type === job.type && dist(s.pos, job.at) < 3);
      const done = site && this.sim.buildProgress(site.id) >= 1;
      if (!e || done || now - job.since > 120 || (!site && now - job.since > 15)) this.engineerJobs.delete(id);
    }
    const idle = engineers.filter((e) => !this.engineerJobs.has(e.id));
    if (!idle.length) return;
    // Resume unfinished construction first (a builder may have died).
    for (const s of this.k.own) {
      if (s.kind !== 'structure' || this.sim.buildProgress(s.id) >= 1) continue;
      if ([...this.engineerJobs.values()].some((j) => j.type === s.type && dist(j.at, s.pos) < 3)) continue;
      const eng = idle.shift();
      if (!eng) return;
      this.send({ type: 'build', builder: eng.id, structure: s.type, at: s.pos, rotation: s.heading });
      this.engineerJobs.set(eng.id, { at: { x: s.pos.x, z: s.pos.z }, type: s.type, since: now });
    }
    if (!idle.length) return;
    const have = new Map<string, number>();
    for (const s of this.k.own) if (s.kind === 'structure') have.set(s.type, (have.get(s.type) ?? 0) + 1);
    for (const j of this.engineerJobs.values()) have.set(j.type, (have.get(j.type) ?? 0) + 1);
    let next: string | null = null;
    for (const [type, n] of this.buildPlan(now)) {
      if ((have.get(type) ?? 0) < n) {
        next = type;
        break;
      }
    }
    if (!next) {
      // Plan done: trenches at the points we hold (Normal/Hard dig in).
      if (this.difficulty !== 'easy' && eco.supply > 600) this.digIn(idle[0], now);
      return;
    }
    const def = STRUCTURE_DEFS[next];
    // Power first if this would brown us out.
    if (next !== 'power_plant' && def.power < 0 && eco.powerProduced - eco.powerUsed + def.power < 0) next = 'power_plant';
    const cost = STRUCTURE_DEFS[next].cost;
    if (!this.sim.buildable(this.player).includes(next)) return;
    if (eco.supply < cost) {
      // Save for core buildings only; extras wait for spare money so the army doesn't starve.
      if (CORE.has(next)) this.pendingBuild = cost;
      return;
    }
    let at = this.placeFor(next);
    if (!at && next === 'naval_yard') {
      // The shore is outside our build radius: put a watchtower toward it first (a stepping stone).
      const shore = this.shorePoint()!;
      const from = [...this.k.own].filter((e) => e.kind === 'structure').sort((a, c) => dist(a.pos, shore) - dist(c.pos, shore))[0];
      if (from && eco.supply >= STRUCTURE_DEFS.watchtower.cost) {
        const d = dist(from.pos, shore) || 1;
        const step = Math.min(120, d - 30);
        const p = { x: from.pos.x + ((shore.x - from.pos.x) / d) * step, z: from.pos.z + ((shore.z - from.pos.z) / d) * step };
        at = this.findSpot('watchtower', p, 0, 40);
        if (at) next = 'watchtower';
      }
    }
    if (!at) return;
    const eng = idle[0];
    this.send({ type: 'build', builder: eng.id, structure: next, at, rotation: 0 });
    this.engineerJobs.set(eng.id, { at, type: next, since: now });
  }

  /** Where to put a structure: depots on supply nodes, naval yards on the shore, the rest near the HQ. */
  private placeFor(type: string): Vec2 | null {
    const b = this.base();
    if (type === 'supply_depot') {
      const nodes = [...(this.map.supplyNodes ?? [])].sort((a, c) => dist(a, b) - dist(c, b));
      for (const n of nodes) {
        if (this.k.own.some((s) => s.type === 'supply_depot' && dist(s.pos, n) < 25)) continue;
        if (this.sim.canPlace(this.player, type, n, 0)) return { x: n.x, z: n.z };
        const near = this.findSpot(type, n, 6, 18);
        if (near) return near;
      }
    }
    if (type === 'naval_yard') {
      const shore = this.shorePoint();
      if (!shore) return null;
      // Search between the base and the water.
      for (let f = 0.9; f >= 0.4; f -= 0.1) {
        const p = { x: b.x + (shore.x - b.x) * f, z: b.z + (shore.z - b.z) * f };
        const s = this.findSpot(type, p, 0, 60);
        if (s) return s;
      }
      return null;
    }
    // Production faces the front: bias the search toward the enemy.
    const e = this.enemyBase();
    const d = dist(e, b) || 1;
    const bias = type === 'power_plant' || type === 'radar' || type === 'strategic_command' ? -30 : 25;
    return this.findSpot(type, { x: b.x + ((e.x - b.x) / d) * bias, z: b.z + ((e.z - b.z) / d) * bias }, 28, 150);
  }

  /** A trench at the held point nearest the enemy, if it's inside our build radius. */
  private digIn(eng: EntityState, now: number): void {
    const held = this.k.points.filter((p) => this.k.isFriend(p.owner));
    if (!held.length) return;
    const e = this.enemyBase();
    held.sort((a, b) => dist(a.pos, e) - dist(b.pos, e));
    const pt = held[0];
    // Only dig where it's quiet: engineers are precious.
    if (this.k.enemyStrength(pt.pos, 200) > 0 || this.k.recentEnemyStrength(pt.pos, 200, 30) > 0) return;
    const trenches = this.k.own.filter((s) => s.type === 'trench' && dist(s.pos, pt.pos) < 40).length;
    if (trenches >= 2) return;
    const d = dist(e, pt.pos) || 1;
    const front = { x: pt.pos.x + ((e.x - pt.pos.x) / d) * 22, z: pt.pos.z + ((e.z - pt.pos.z) / d) * 22 };
    const at = this.findSpot('trench', front, 0, 20);
    if (!at) return;
    this.send({ type: 'build', builder: eng.id, structure: 'trench', at, rotation: Math.abs(e.x - pt.pos.x) > Math.abs(e.z - pt.pos.z) ? Math.PI / 2 : 0 });
    this.engineerJobs.set(eng.id, { at, type: 'trench', since: now });
  }

  // --- production ---

  private production(now: number): void {
    const eco = this.sim.economy(this.player);
    if (!eco) return;
    let supply = eco.supply;
    // Keep money for the next building in the plan so the base (and tech) keeps growing.
    const reserve = now > 60 ? this.pendingBuild * 0.6 : 0;
    const mix = this.desiredMix(eco.tier);
    const counts = new Map<string, number>();
    let total = 0;
    let infantryCp = 0;
    for (const e of this.k.own) {
      if (e.kind !== 'unit') continue;
      const d = UNIT_DEFS[e.type];
      if (d?.armor === 'infantry' && !d.builder) infantryCp += d.cp / (d.squad ?? 1);
      if (!mix[e.type]) continue;
      const v = valueOf(e.type);
      counts.set(e.type, (counts.get(e.type) ?? 0) + v);
      total += v;
    }
    let cp = eco.cp;
    // Near the command-point cap, what matters is value per CP: prefer heavier units, and once Tier 2
    // is up don't let cheap infantry fill more than about half the cap.
    const capped = cp > eco.cpCap * 0.7;
    const infantryFull = eco.tier >= 2 && infantryCp >= eco.cpCap * 0.45;
    const wantTransport = this.p.transports && this.needsTransport();
    const cands: { f: EntityState; unit: string; score: number }[] = [];
    for (const f of this.k.own) {
      if (f.kind !== 'structure' || f.type === 'hq' || !this.complete(f)) continue;
      if (this.sim.queue(f.id).length >= this.p.queue) continue;
      const producible = this.sim.producible(f.id);
      // Transports when a point needs one (they're not part of the fighting mix).
      if (wantTransport && producible.includes('heli_transport') && !this.k.own.some((e) => e.type === 'heli_transport')) {
        cands.push({ f, unit: 'heli_transport', score: 1 });
        continue;
      }
      if (wantTransport && producible.includes('transport_ship') && !this.k.own.some((e) => e.type === 'transport_ship' || e.type === 'heli_transport')) {
        cands.push({ f, unit: 'transport_ship', score: 0.9 });
        continue;
      }
      const options = producible.filter((u) => mix[u] && u !== 'engineer' && !(infantryFull && UNIT_DEFS[u].armor === 'infantry'));
      if (!options.length) continue;
      let wsum = 0;
      for (const u of options) wsum += mix[u];
      let pick: string | null = null;
      let bestScore = -Infinity;
      for (const u of options) {
        const want = mix[u] / wsum;
        const share = total > 0 ? (counts.get(u) ?? 0) / total : 0;
        const d = UNIT_DEFS[u];
        const perCp = capped ? Math.min(2, d.cost / Math.max(1, d.cp) / 60) : 1;
        const score = (want - share) * (want > share ? perCp : 1) + this.rand.next() * 0.08;
        if (score > bestScore) {
          bestScore = score;
          pick = u;
        }
      }
      if (pick) cands.push({ f, unit: pick, score: bestScore });
    }
    // Buy in priority order. If the top pick can't be afforded yet, save for it (for up to a minute).
    cands.sort((x, y) => y.score - x.score);
    for (let i = 0; i < cands.length; i++) {
      const { f, unit } = cands[i];
      const def = UNIT_DEFS[unit];
      // Keep a little CP free for engineers.
      if (cp + def.cp > eco.cpCap - 2) continue;
      if (supply - reserve < def.cost) {
        if (this.saveFor?.unit !== unit) this.saveFor = { unit, since: now };
        if (now - this.saveFor.since < 60) break;
        continue;
      }
      if (this.saveFor?.unit === unit) this.saveFor = null;
      supply -= def.cost;
      cp += def.cp;
      counts.set(unit, (counts.get(unit) ?? 0) + valueOf(unit) * (def.squad ?? 1));
      total += def.cost;
      this.send({ type: 'produce', factory: f.id, unit, count: 1 });
    }
  }

  /** Base weights for the tier, pushed toward counters for what the enemy fields. */
  private desiredMix(tier: number): Record<string, number> {
    const mix = { ...BASE_MIX[Math.min(3, Math.max(1, tier))] };
    if (!this.naval) for (const u of ['patrol_boat', 'destroyer', 'submarine', 'cruiser']) delete mix[u];
    if (this.p.counters) {
      const { mix: seen, total } = this.k.enemyMix();
      if (total > 300) {
        for (const [role, share] of Object.entries(seen) as [Role, number][]) {
          const c = COUNTERS[role];
          if (!c || share < 0.12) continue;
          for (const [u, w] of Object.entries(c)) if (mix[u] !== undefined || UNIT_DEFS[u]?.tier <= tier) mix[u] = (mix[u] ?? 0) + w * share * 4;
        }
      }
    }
    return mix;
  }

  private needsTransport(): boolean {
    const b = this.base();
    return this.k.points.some((p) => !this.k.isFriend(p.owner) && !this.sim.reachable('ground', b, p.pos));
  }

  // --- military ---

  private armyUnits(): EntityState[] {
    return this.k.own.filter((e) => {
      if (e.kind !== 'unit' || e.inside) return false;
      const r = roleOf(e.type);
      return r !== 'support' && r !== 'transport';
    });
  }

  private forceValue(f: TaskForce): number {
    let v = 0;
    for (const id of f.units) {
      const e = this.sim.get(id);
      if (e) v += (valueOf(e.type) * e.hp) / Math.max(1, e.maxHp);
    }
    return v;
  }

  private military(now: number): void {
    const army = this.armyUnits();
    const alive = new Set(this.k.own.map((e) => e.id));
    for (const f of this.forces) for (const id of [...f.units]) if (!alive.has(id)) f.units.delete(id);
    for (const [id] of this.assigned) if (!alive.has(id)) this.assigned.delete(id);
    for (const id of [...this.raiders]) if (!alive.has(id)) this.raiders.delete(id);

    this.defendBase(army);
    if (this.p.scout) this.runScout(army);
    if (now >= this.p.raidFrom) this.runRaids(army);

    // Drop forces whose objective went away (point captured and secure for a while is handled in tick).
    this.forces = this.forces.filter((f) => f.units.size > 0 || now - f.since < 30);

    // Pool: army units not in a force, raid or scout.
    const pool = army.filter((e) => !this.assigned.has(e.id) && !this.raiders.has(e.id) && e.id !== this.scoutId);
    if (this.turtling) return;
    const objectives = this.objectives();
    // Small armies concentrate: one force per ~900 supply of army, up to the difficulty's limit.
    let armyValue = 0;
    for (const u of army) armyValue += valueOf(u.type);
    const maxForces = Math.max(1, Math.min(this.p.forces, 1 + Math.floor(armyValue / 900)));
    if (this.forces.length > maxForces) {
      // Fold the weakest forces into the others.
      this.forces.sort((a, b) => this.forceValue(b) - this.forceValue(a));
      for (const f of this.forces.splice(maxForces)) for (const id of f.units) this.assigned.delete(id);
    }
    // Re-target: a force chasing a point that dropped out of the top choices switches to the best one
    // nobody is handling (a threatened home point outranks a raid on the enemy's backyard).
    const top = objectives.slice(0, maxForces + 1).map((o) => o.id);
    for (const f of this.forces) {
      if (f.state === 'board' || f.state === 'ferry' || top.includes(f.point)) continue;
      if (f.state === 'hold' && this.k.enemyStrength(this.sim.get(f.point)?.pos ?? this.base(), 160) > 0) continue;
      const next = objectives.find((o) => top.includes(o.id) && !this.forces.some((x) => x.point === o.id));
      if (!next) continue;
      f.point = next.id;
      f.state = 'gather';
      f.since = now;
      f.ordersAt = -999;
      f.lined = false;
    }
    // Start new forces on the best unhandled objectives.
    for (const obj of objectives) {
      if (this.forces.length >= maxForces || !pool.length) break;
      if (this.forces.some((f) => f.point === obj.id)) continue;
      const f: TaskForce = { id: this.nextForceId++, units: new Set(), point: obj.id, state: 'gather', since: now, ordersAt: -999, transport: 0, lined: false };
      this.forces.push(f);
    }
    // Give pool units to the force that needs strength most (nearest first).
    for (const u of pool) {
      let best: TaskForce | null = null;
      let bestNeed = -Infinity;
      for (const f of this.forces) {
        const pt = this.sim.get(f.point);
        if (!pt) continue;
        if (!this.canReach(u, pt.pos) && !this.p.transports) continue;
        const need = this.required(f) - this.forceValue(f) - dist(u.pos, pt.pos) * 0.5;
        if (need > bestNeed) {
          bestNeed = need;
          best = f;
        }
      }
      if (best) {
        best.units.add(u.id);
        this.assigned.set(u.id, best.id);
      }
    }
    for (const f of this.forces) this.runForce(f, now);
  }

  /** Can this unit get to `p` on its own (aircraft always; ships by water; troops by land)? */
  private canReach(u: EntityState, p: Vec2): boolean {
    const d = UNIT_DEFS[u.type]?.domain;
    if (d === 'air') return true;
    if (d === 'naval') return true; // ships fight from the water near a point
    return this.sim.reachable('ground', u.pos, p);
  }

  /** Capture points worth going for, best first. */
  private objectives(): EntityState[] {
    const b = this.base();
    const army = this.armyUnits();
    let ours = 0;
    for (const u of army) ours += valueOf(u.type);
    const scored: { e: EntityState; s: number }[] = [];
    for (const pt of this.k.points) {
      const friendly = this.k.isFriend(pt.owner);
      const threat = this.k.enemyStrength(pt.pos, 140) + this.k.recentEnemyStrength(pt.pos, 140) * 0.5;
      const ground = this.sim.reachable('ground', b, pt.pos);
      if (!ground && !(this.p.transports && this.k.own.some((e) => e.type === 'heli_transport' || e.type === 'transport_ship'))) continue;
      const e = this.enemyBase();
      // Closer to us than to them is easier to take and hold.
      const depth = dist(b, pt.pos) / Math.max(1, dist(b, pt.pos) + dist(e, pt.pos));
      let s = (1000 / (dist(b, pt.pos) + 250)) * (1.4 - depth);
      if (friendly) s *= threat > 0 ? 1.6 : 0.15;
      else if (pt.owner >= 0) s *= 1.4; // deny the enemy's bleed
      s /= 1 + threat / Math.max(200, ours);
      if (!ground) s *= 0.7;
      scored.push({ e: pt, s });
    }
    scored.sort((a, b2) => b2.s - a.s);
    return scored.map((x) => x.e);
  }

  /** Strength a force wants before it attacks. */
  private required(f: TaskForce): number {
    const pt = this.sim.get(f.point);
    if (!pt) return 0;
    const known = this.k.enemyStrength(pt.pos, 150) + this.k.recentEnemyStrength(pt.pos, 150) * 0.6;
    // Nobody seen there: just go (an empty neutral point is a free grab).
    const floor = known > 0 || this.k.isEnemy(pt.owner) ? (this.difficulty === 'easy' ? 300 : 400) : 0;
    return Math.max(floor, known * this.p.overmatch);
  }

  private unitsOf(f: TaskForce): EntityState[] {
    const out: EntityState[] = [];
    for (const id of f.units) {
      const e = this.sim.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  private runForce(f: TaskForce, now: number): void {
    const pt = this.sim.get(f.point);
    const units = this.unitsOf(f);
    if (!pt || !units.length) return;
    const ids = units.filter((u) => !u.inside).map((u) => u.id);
    const value = this.forceValue(f);
    const center = centroid(units.map((u) => u.pos));
    const enemyNear = this.k.enemyStrength(pt.pos, 160);
    const ours = this.k.isFriend(pt.owner);
    const b = this.base();
    const groundOk = this.sim.reachable('ground', b, pt.pos);
    const since = now - f.since;
    const set = (s: TaskForce['state']) => {
      f.state = s;
      f.since = now;
      f.ordersAt = -999;
    };

    switch (f.state) {
      case 'gather': {
        if (!groundOk && this.p.transports) {
          set('board');
          return;
        }
        const staging = this.stagingFor(pt.pos);
        if (now - f.ordersAt > 15 && ids.length) {
          this.send({ type: 'move', units: ids, target: staging, attackMove: true });
          f.ordersAt = now;
        }
        if (value >= this.required(f) || (since > 60 && value > this.required(f) * 0.6) || ours) set('attack');
        break;
      }
      case 'attack': {
        if (ours && enemyNear === 0 && dist(center, pt.pos) < 60) {
          set('hold');
          break;
        }
        if (this.p.retreat && value < enemyNear * 0.45 && dist(center, pt.pos) < 220) {
          set('retreat');
          break;
        }
        // Whittled down far below what the objective needs: regroup instead of trickling in.
        if (!ours && value < this.required(f) * 0.4 && since > 20) {
          set('gather');
          break;
        }
        if (now - f.ordersAt > 20 && ids.length) {
          // Attack with the main body; stragglers and fresh reinforcements catch up with it first
          // instead of trickling into the enemy one by one.
          const free = units.filter((u) => !u.inside);
          const byDist = [...free].sort((a, b) => dist(a.pos, pt.pos) - dist(b.pos, pt.pos));
          const front = centroid(byDist.slice(0, Math.max(1, Math.ceil(byDist.length / 2))).map((u) => u.pos));
          const body = free.filter((u) => dist(u.pos, front) < 150).map((u) => u.id);
          const late = free.filter((u) => dist(u.pos, front) >= 150).map((u) => u.id);
          if (late.length) this.send({ type: 'move', units: late, target: front, attackMove: true });
          const flank = this.p.flank > 0 && this.rand.next() < this.p.flank && dist(front, pt.pos) > 160;
          if (body.length) {
            if (flank) {
              const wp = this.flankPoint(front, pt.pos);
              this.send({ type: 'move', units: body, target: wp, attackMove: true });
              this.send({ type: 'move', units: body, target: pt.pos, attackMove: true, queue: true });
            } else this.send({ type: 'move', units: body, target: pt.pos, attackMove: true });
          }
          if (this.p.abilities && dist(front, pt.pos) > 180) this.sprint(free.filter((u) => body.includes(u.id)));
          f.ordersAt = now;
        }
        break;
      }
      case 'retreat': {
        if (now - f.ordersAt > 30 && ids.length) {
          this.send({ type: 'move', units: ids, target: this.stagingFor(pt.pos, 0.35) });
          f.ordersAt = now;
        }
        if (since > 25) set('gather');
        break;
      }
      case 'hold': {
        if (!ours) {
          f.lined = false;
          set('attack');
          break;
        }
        if (f.ordersAt < 0) {
          if (this.p.lines && ids.length >= 3) {
            this.send({ type: 'holdLine', units: ids, points: this.lineAcross(pt.pos, ids.length) });
            f.lined = true;
          } else this.send({ type: 'move', units: ids, target: pt.pos, attackMove: true });
          f.ordersAt = now;
          if (this.p.abilities) this.digInUnits(units);
        } else if (now - f.ordersAt > 10) {
          // Reinforcements join the line where it's weakest; without a line they gather on the point.
          const lineId = units.find((u) => u.line)?.line;
          const fresh = units.filter((u) => !u.inside && !u.line && dist(u.pos, pt.pos) > 30).map((u) => u.id);
          if (fresh.length) {
            if (lineId) this.send({ type: 'holdLine', units: fresh, points: [], line: lineId });
            else this.send({ type: 'move', units: fresh, target: pt.pos, attackMove: true });
          }
          f.ordersAt = now;
        }
        // A quiet point keeps a small garrison and releases the rest.
        if (since > 40 && enemyNear === 0 && units.length > 6) {
          const release = units.slice(Math.ceil(units.length / 2));
          for (const u of release) {
            f.units.delete(u.id);
            this.assigned.delete(u.id);
          }
        }
        // Once secure for a while, the force moves on to the next objective.
        if (since > 70 && enemyNear === 0) {
          const next = this.objectives().find((o) => !this.forces.some((x) => x.point === o.id) && !this.k.isFriend(o.owner));
          if (next) {
            f.point = next.id;
            f.lined = false;
            set('gather');
          }
        }
        break;
      }
      case 'board': {
        // Air or sea assault on a point troops can't walk to.
        const t = this.transportFor(f);
        if (!t) {
          if (since > 90) set('gather');
          break;
        }
        f.transport = t.id;
        const aboard = units.filter((u) => u.inside === t.id).length;
        const infantry = units.filter((u) => !u.inside && UNIT_DEFS[u.type]?.armor === 'infantry' && UNIT_DEFS[u.type]?.domain === 'ground');
        if (aboard >= 4 || (aboard > 0 && !infantry.length) || (aboard > 0 && since > 60)) {
          set('ferry');
          break;
        }
        if (now - f.ordersAt > 12 && infantry.length) {
          const seats = UNIT_DEFS[t.type].transport?.seats ?? 8;
          const go = infantry.slice(0, seats).map((u) => u.id);
          if (t.type === 'transport_ship') {
            const shore = this.shorePoint();
            if (shore) this.send({ type: 'move', units: [t.id], target: shore });
          } else this.send({ type: 'move', units: [t.id], target: centroid(infantry.map((u) => u.pos)) });
          this.send({ type: 'enter', units: go, target: t.id });
          f.ordersAt = now;
        }
        break;
      }
      case 'ferry': {
        const t = this.sim.get(f.transport);
        if (!t || !(t.cargo?.length)) {
          set(ours ? 'hold' : 'attack');
          break;
        }
        if (now - f.ordersAt > 20) {
          this.send({ type: 'unload', units: [t.id], at: pt.pos });
          f.ordersAt = now;
        }
        break;
      }
    }
  }

  private transportFor(f: TaskForce): EntityState | undefined {
    const free = this.k.own.filter((e) => (e.type === 'heli_transport' || e.type === 'transport_ship') && !this.forces.some((o) => o !== f && o.transport === e.id && (o.state === 'board' || o.state === 'ferry')));
    return free.find((e) => e.type === 'heli_transport') ?? free[0];
  }

  /** A gathering spot short of the objective: our nearest held point, or part of the way there. */
  private stagingFor(target: Vec2, frac = 0.55): Vec2 {
    const b = this.base();
    const held = this.k.points.filter((p) => this.k.isFriend(p.owner) && dist(p.pos, target) > 80);
    let best: Vec2 = { x: b.x + (target.x - b.x) * frac, z: b.z + (target.z - b.z) * frac };
    let bestD = dist(best, target);
    for (const p of held) {
      const d = dist(p.pos, target);
      if (d < bestD && this.sim.reachable('ground', p.pos, target)) {
        bestD = d;
        best = { x: p.pos.x + (target.x - p.pos.x) * 0.3, z: p.pos.z + (target.z - p.pos.z) * 0.3 };
      }
    }
    return best;
  }

  /** A waypoint off to the side of the approach, on the side with less known enemy. */
  private flankPoint(from: Vec2, to: Vec2): Vec2 {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = -dz / d;
    const nz = dx / d;
    const off = 120;
    const mid = { x: from.x + dx * 0.6, z: from.z + dz * 0.6 };
    const a = { x: mid.x + nx * off, z: mid.z + nz * off };
    const c = { x: mid.x - nx * off, z: mid.z - nz * off };
    const half = this.map.size / 2 - 20;
    const clamp = (p: Vec2) => ({ x: Math.max(-half, Math.min(half, p.x)), z: Math.max(-half, Math.min(half, p.z)) });
    const sa = this.k.enemyStrength(a, 120) + (this.sim.reachable('ground', from, a) ? 0 : 1e6);
    const sc = this.k.enemyStrength(c, 120) + (this.sim.reachable('ground', from, c) ? 0 : 1e6);
    return clamp(sa <= sc ? a : c);
  }

  /** A frontline across the approach to a held point, facing the nearest enemy-held point or base. */
  private lineAcross(p: Vec2, n: number): Vec2[] {
    const enemyPts = this.k.points.filter((q) => this.k.isEnemy(q.owner));
    let toward = this.enemyBase();
    let best = dist(p, toward);
    for (const q of enemyPts) {
      const d = dist(p, q.pos);
      if (d < best) {
        best = d;
        toward = q.pos;
      }
    }
    const dx = toward.x - p.x;
    const dz = toward.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    const fx = dx / d;
    const fz = dz / d;
    const c = { x: p.x + fx * 30, z: p.z + fz * 30 };
    const half = Math.min(90, Math.max(30, 18 + n * 4));
    return [
      { x: c.x - fz * half, z: c.z + fx * half },
      { x: c.x, z: c.z },
      { x: c.x + fz * half, z: c.z - fx * half },
    ];
  }

  /** Visible enemies near our buildings: everyone close by turns to meet them. */
  private defendBase(army: EntityState[]): void {
    const structures = this.k.own.filter((s) => s.kind === 'structure');
    const threats = this.k.visible.filter((e) => structures.some((s) => dist(s.pos, e.pos) < 160));
    if (!threats.length) return;
    let threat = 0;
    for (const t of threats) threat += valueOf(t.type);
    if (threat < 150) return;
    const c = centroid(threats.map((t) => t.pos));
    const near = army.filter((u) => dist(u.pos, c) < 450).sort((a, b) => dist(a.pos, c) - dist(b.pos, c));
    let sent = 0;
    const ids: EntityId[] = [];
    for (const u of near) {
      if (sent > threat * 1.5) break;
      ids.push(u.id);
      sent += valueOf(u.type);
    }
    if (!ids.length) return;
    // Too weak to win: gather at the HQ (defenses, hospital) instead of feeding units in one by one,
    // unless they're already hitting our buildings.
    const hitting = threats.some((t) => structures.some((st) => dist(st.pos, t.pos) < 60));
    if (sent < threat * 0.7 && !hitting) {
      const home = this.base();
      const out = ids.filter((id) => {
        const u = this.sim.get(id);
        return u && dist(u.pos, home) > 40;
      });
      if (out.length) this.send({ type: 'move', units: out, target: home });
      for (const id of ids) {
        const f = this.assigned.get(id);
        if (f !== undefined) this.forces.find((x) => x.id === f)?.units.delete(id);
        this.assigned.delete(id);
      }
      this.turtling = true;
      return;
    }
    this.turtling = false;
    this.send({ type: 'move', units: ids, target: c, attackMove: true });
  }

  /** Early on, one fast unit looks at the points and the enemy base. */
  private runScout(army: EntityState[]): void {
    let s = this.scoutId ? this.sim.get(this.scoutId) : undefined;
    if (!s && this.scoutStep === 0) {
      const cand = army.find((u) => u.type === 'jeep' || u.type === 'scout_car');
      if (!cand) return;
      this.scoutId = cand.id;
      const f = this.assigned.get(cand.id);
      if (f !== undefined) this.forces.find((x) => x.id === f)?.units.delete(cand.id);
      this.assigned.delete(cand.id);
      s = cand;
    }
    if (!s) return;
    const route = [...this.k.points.map((p) => p.pos), ...this.enemySpawns];
    if (this.scoutStep >= route.length) {
      // Done scouting: rejoin the army.
      this.scoutId = 0;
      this.scoutStep = 999;
      return;
    }
    const target = route[this.scoutStep];
    if (dist(s.pos, target) < 40 || !s.moving) {
      if (dist(s.pos, target) < 40) this.scoutStep++;
      const next = route[Math.min(this.scoutStep, route.length - 1)];
      this.send({ type: 'move', units: [s.id], target: next });
    }
  }

  /** Fast units hunt supply trucks, depots and power plants away from the enemy army. */
  private runRaids(army: EntityState[]): void {
    while (this.raiders.size < this.p.raiders) {
      const cand = army.find((u) => RAIDER_TYPES.has(u.type) && !this.raiders.has(u.id) && u.id !== this.scoutId);
      if (!cand) break;
      const f = this.assigned.get(cand.id);
      if (f !== undefined) this.forces.find((x) => x.id === f)?.units.delete(cand.id);
      this.assigned.delete(cand.id);
      this.raiders.add(cand.id);
    }
    if (!this.raiders.size) return;
    const raiders = [...this.raiders].map((id) => this.sim.get(id)).filter((e): e is EntityState => !!e);
    const c = centroid(raiders.map((r) => r.pos));
    // Pull back badly hurt raiders.
    for (const r of raiders) {
      if (r.hp < r.maxHp * 0.35) {
        this.raiders.delete(r.id);
        this.send({ type: 'move', units: [r.id], target: this.base() });
      }
    }
    const trucks = this.k.visible.filter((e) => e.type === 'supply_truck');
    let target: { id?: EntityId; pos: Vec2 } | null = null;
    let best = Infinity;
    for (const t of trucks) {
      const d = dist(t.pos, c);
      if (d < best && this.k.enemyStrength(t.pos, 120) < 300) {
        best = d;
        target = { id: t.id, pos: t.pos };
      }
    }
    if (!target) {
      for (const s of this.k.enemyStructures()) {
        if (s.type !== 'supply_depot' && s.type !== 'power_plant') continue;
        const d = dist(s.pos, c) + this.k.enemyStrength(s.pos, 150) * 0.5;
        if (d < best) {
          best = d;
          target = { id: this.sim.fog.canSee(this.player, s.id) ? s.id : undefined, pos: s.pos };
        }
      }
    }
    const ids = raiders.filter((r) => this.raiders.has(r.id)).map((r) => r.id);
    if (!ids.length) return;
    if (target?.id !== undefined) this.send({ type: 'attack', units: ids, targetId: target.id });
    else if (target) this.send({ type: 'move', units: ids, target: target.pos, attackMove: true });
    else {
      // Nothing known: sweep toward the enemy base's flank to find their supply lines.
      const e = this.enemyBase();
      this.send({ type: 'move', units: ids, target: this.flankPoint(this.base(), e), attackMove: true });
    }
  }

  // --- abilities ---

  private ready(key: string, now: number, cooldown: number): boolean {
    if ((this.abilityAt.get(key) ?? -1e9) + cooldown > now) return false;
    this.abilityAt.set(key, now);
    return true;
  }

  private sprint(units: EntityState[]): void {
    const inf = units.filter((u) => this.sim.abilities(u.id).some((a) => (a.ability === 'sprint' || a.ability === 'overdrive') && a.cooldown <= 0));
    const sprinters = inf.filter((u) => this.sim.abilities(u.id).some((a) => a.ability === 'sprint')).map((u) => u.id);
    const drivers = inf.filter((u) => this.sim.abilities(u.id).some((a) => a.ability === 'overdrive')).map((u) => u.id);
    if (sprinters.length) this.send({ type: 'useAbility', units: sprinters, ability: 'sprint' });
    if (drivers.length) this.send({ type: 'useAbility', units: drivers, ability: 'overdrive' });
  }

  /** Holding infantry dig in; anti-tank teams set ambushes. */
  private digInUnits(units: EntityState[]): void {
    const dig = units.filter((u) => u.type === 'rifleman' || u.type === 'sniper').map((u) => u.id);
    const ambush = units.filter((u) => u.type === 'at_soldier').map((u) => u.id);
    if (dig.length) this.send({ type: 'useAbility', units: dig, ability: 'entrench' });
    if (ambush.length && this.difficulty === 'hard') this.send({ type: 'useAbility', units: ambush, ability: 'ambush' });
  }

  private useAbilities(now: number): void {
    const own = this.k.own;
    // Barrage visible enemy clusters in range of artillery.
    const arty = own.filter((e) => e.type === 'artillery' || e.type === 'rocket_truck' || e.type === 'cruiser');
    for (const a of arty) {
      if (!this.sim.abilities(a.id).some((x) => x.ability === 'barrage' && x.cooldown <= 0)) continue;
      const range = a.type === 'artillery' ? 300 : a.type === 'rocket_truck' ? 240 : 260;
      let best: Vec2 | null = null;
      let bestV = 0;
      for (const e of this.k.visible) {
        if (dist(e.pos, a.pos) > range) continue;
        let v = 0;
        for (const o of this.k.visible) if (dist(o.pos, e.pos) < 25) v += valueOf(o.type);
        if (v > bestV) {
          bestV = v;
          best = e.pos;
        }
      }
      for (const s of this.k.enemyStructures()) {
        if (dist(s.pos, a.pos) > range || !this.sim.fog.isVisible(this.player, s.pos.x, s.pos.z)) continue;
        const v = valueOf(s.type) * 0.8;
        if (v > bestV) {
          bestV = v;
          best = s.pos;
        }
      }
      if (best && bestV >= 450) this.send({ type: 'useAbility', units: [a.id], ability: 'barrage', at: { x: best.x, z: best.z } });
    }
    // Smoke: a squad under fire from nearby enemies covers itself.
    if (this.ready('smoke', now, 8)) {
      for (const u of own) {
        if (u.kind !== 'unit' || u.hp > u.maxHp * 0.7) continue;
        if (!this.sim.abilities(u.id).some((x) => x.ability === 'smoke' && x.cooldown <= 0)) continue;
        const foe = this.k.visible.find((e) => dist(e.pos, u.pos) < 70);
        if (!foe) continue;
        this.send({ type: 'useAbility', units: [u.id], ability: 'smoke', at: { x: (u.pos.x + foe.pos.x) / 2, z: (u.pos.z + foe.pos.z) / 2 } });
        break;
      }
    }
    // Hard: damaged vehicles fall back to repair near the base.
    if (this.p.micro) {
      for (const u of own) {
        if (u.kind !== 'unit' || u.inside || u.line) continue;
        const d = UNIT_DEFS[u.type];
        if (!d || d.armor === 'infantry' || d.domain === 'naval' || u.hp > u.maxHp * 0.25) continue;
        if (dist(u.pos, this.base()) < 120) continue;
        const f = this.assigned.get(u.id);
        if (f !== undefined) this.forces.find((x) => x.id === f)?.units.delete(u.id);
        this.assigned.delete(u.id);
        this.send({ type: 'move', units: [u.id], target: this.base() });
      }
    }
  }

  /** Fire the cruise missile at the most valuable thing we know about. */
  private useSuperweapon(): void {
    const sw = this.sim.superweapon(this.player);
    if (!sw?.ready) return;
    const cands: Vec2[] = [...this.k.enemyStructures().map((s) => s.pos), ...this.k.visible.map((e) => e.pos)];
    let best: Vec2 | null = null;
    let bestV = 0;
    for (const c of cands) {
      let v = 0;
      for (const s of this.k.enemyStructures()) if (dist(s.pos, c) < 32) v += valueOf(s.type) * (STRUCTURE_DEFS[s.type]?.production ? 1.4 : 1);
      for (const e of this.k.visible) if (dist(e.pos, c) < 32) v += valueOf(e.type);
      // Don't hit our own troops.
      for (const o of this.k.own) if (o.kind === 'unit' && dist(o.pos, c) < 40) v -= valueOf(o.type) * 2;
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (best && bestV >= 900) this.send({ type: 'superweapon', at: { x: best.x, z: best.z } });
  }
}
