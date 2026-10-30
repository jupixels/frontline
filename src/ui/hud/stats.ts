import type { EntityKind, SimView } from '../../shared/entities';
import type { SimEvent } from '../../shared/events';
import { SIM_HZ, type EntityId, type MatchSetup, type PlayerId } from '../../shared/types';
import type { MatchFacts } from '../records';
import type { PlayerStats } from '../screens/results';
import type { SimAdapter } from '../simAdapter';

interface Known {
  owner: PlayerId;
  kind: EntityKind;
  type: string;
}

/** One point of the post-match graphs. */
export interface StatSample {
  /** Game seconds. */
  t: number;
  /** Morale per team. */
  morale: Record<number, number>;
  /** Per player: army value (supply cost of living units), points held, kills so far. */
  army: Record<number, number>;
  points: Record<number, number>;
  kills: Record<number, number>;
}

const SAMPLE_SECONDS = 10;

/**
 * Tallies per-player match stats from SimEvents for the results screen, samples a timeline for the
 * post-match graphs, and notes what the local army did for medals. Keeps a small cache of entity
 * owners so `died`/`hit` still resolve after the sim removed the entity.
 */
export class StatsTracker {
  private readonly stats = new Map<PlayerId, PlayerStats>();
  private readonly known = new Map<EntityId, Known>();
  readonly timeline: StatSample[] = [];
  private nextSample = 0;
  private readonly army: PlayerId;
  readonly facts: MatchFacts;

  constructor(
    private readonly sim: SimView,
    setup: MatchSetup,
    private readonly adapter: SimAdapter,
    local: PlayerId,
  ) {
    for (const p of setup.players) {
      this.stats.set(p.id, { player: p.id, unitsProduced: 0, unitsLost: 0, kills: 0, structuresBuilt: 0, damageDealt: 0, pointsCaptured: 0 });
    }
    for (const e of sim.entities()) this.known.set(e.id, { owner: e.owner, kind: e.kind, type: e.type });
    this.army = adapter.armyOf(local);
    const myTeam = adapter.teamOf(local);
    const ais = setup.players.filter((p) => p.kind === 'ai' && p.team !== myTeam).map((p) => p.aiDifficulty ?? 'normal');
    this.facts = {
      won: null,
      durationSec: 0,
      mode: '',
      vsAi: ais.includes('hard') ? 'hard' : ais.includes('normal') ? 'normal' : ais.length ? 'easy' : undefined,
      coop: adapter.coCommanders(local).length > 0,
      kills: 0,
      structuresLost: 0,
      minMoraleFrac: 1,
      domains: new Set(),
      linesFormed: 0,
      missiles: 0,
      maxRank: 0,
      heldAllPoints: false,
    };
  }

  /** Owner/kind/type of an entity, even after it was removed. */
  info(id: EntityId): Known | undefined {
    const e = this.sim.get(id);
    if (e) {
      const k = { owner: e.owner, kind: e.kind, type: e.type };
      this.known.set(id, k);
      return k;
    }
    return this.known.get(id);
  }

  handle(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'spawned':
          this.info(ev.id);
          break;
        case 'produced': {
          const f = this.info(ev.factory);
          const u = this.info(ev.unit);
          if (f) this.bump(f.owner, 'unitsProduced');
          if (f?.owner === this.army && u) this.facts.domains.add(this.adapter.unitDef(u.type)?.domain ?? 'ground');
          break;
        }
        case 'built': {
          const s = this.info(ev.id);
          if (s) this.bump(s.owner, 'structuresBuilt');
          break;
        }
        case 'died': {
          const v = this.info(ev.id);
          if (v && v.kind !== 'projectile') this.bump(v.owner, 'unitsLost');
          if (v?.kind === 'structure' && v.owner === this.army) this.facts.structuresLost++;
          const k = ev.killer !== undefined ? this.info(ev.killer) : undefined;
          if (k && v && k.owner !== v.owner) this.bump(k.owner, 'kills');
          break;
        }
        case 'hit': {
          const by = ev.by !== undefined ? this.info(ev.by) : undefined;
          const v = this.info(ev.id);
          if (by && (!v || by.owner !== v.owner)) this.bump(by.owner, 'damageDealt', ev.damage);
          break;
        }
        case 'captured':
          this.bump(ev.by, 'pointsCaptured');
          break;
        case 'line':
          if (ev.change === 'formed' && ev.owner === this.army) this.facts.linesFormed++;
          break;
        case 'superweaponLaunched':
          if (ev.player === this.army) this.facts.missiles++;
          break;
        case 'promoted': {
          const u = this.info(ev.id);
          if (u?.owner === this.army) this.facts.maxRank = Math.max(this.facts.maxRank, ev.rank);
          break;
        }
        case 'removed':
          // Keep the cache entry: `died` for this id may arrive in the same batch.
          break;
      }
    }
    const tick = this.sim.gameTick ?? this.sim.tick;
    if (tick >= this.nextSample) {
      this.nextSample = tick + SAMPLE_SECONDS * SIM_HZ;
      this.sample(tick / SIM_HZ);
    }
  }

  private sample(t: number): void {
    const a = this.adapter;
    const s: StatSample = { t, morale: {}, army: {}, points: {}, kills: {} };
    for (const tm of a.teamMorale()) s.morale[tm.team] = Math.max(0, Math.round(tm.morale));
    for (const p of a.setup.players) {
      s.army[p.id] = 0;
      s.points[p.id] = 0;
      s.kills[p.id] = this.stats.get(p.id)?.kills ?? 0;
    }
    for (const e of this.sim.entities()) {
      if (e.kind === 'unit' && e.owner >= 0 && s.army[e.owner] !== undefined) s.army[e.owner] += a.units[e.type]?.cost ?? 0;
    }
    const pts = a.points();
    for (const p of pts) if (p.owner >= 0 && s.points[p.owner] !== undefined) s.points[p.owner]++;
    this.timeline.push(s);
    const myTeam = a.teamOf(this.army);
    const mine = a.teamMorale().find((x) => x.team === myTeam);
    if (mine && mine.max > 0) this.facts.minMoraleFrac = Math.min(this.facts.minMoraleFrac, mine.morale / mine.max);
    if (pts.length && pts.every((p) => p.owner >= 0 && a.teamOf(p.owner) === myTeam)) this.facts.heldAllPoints = true;
  }

  private bump(p: PlayerId, key: Exclude<keyof PlayerStats, 'player'>, by = 1): void {
    const s = this.stats.get(p);
    if (s) s[key] += by;
  }

  all(): PlayerStats[] {
    return [...this.stats.values()];
  }

  /** Close the timeline at the final tick. */
  finish(tick: number): void {
    this.sample(tick / SIM_HZ);
    this.facts.kills = this.stats.get(this.army)?.kills ?? 0;
  }
}
