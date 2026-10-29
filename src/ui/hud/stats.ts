import type { EntityKind, SimView } from '../../shared/entities';
import type { SimEvent } from '../../shared/events';
import type { EntityId, MatchSetup, PlayerId } from '../../shared/types';
import type { PlayerStats } from '../screens/results';

interface Known {
  owner: PlayerId;
  kind: EntityKind;
  type: string;
}

/**
 * Tallies per-player match stats from SimEvents for the results screen. Keeps a small cache of
 * entity owners so `died`/`hit` still resolve after the sim removed the entity.
 */
export class StatsTracker {
  private readonly stats = new Map<PlayerId, PlayerStats>();
  private readonly known = new Map<EntityId, Known>();

  constructor(
    private readonly sim: SimView,
    setup: MatchSetup,
  ) {
    for (const p of setup.players) {
      this.stats.set(p.id, { player: p.id, unitsProduced: 0, unitsLost: 0, kills: 0, structuresBuilt: 0, damageDealt: 0, pointsCaptured: 0 });
    }
    for (const e of sim.entities()) this.known.set(e.id, { owner: e.owner, kind: e.kind, type: e.type });
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
          this.info(ev.unit);
          if (f) this.bump(f.owner, 'unitsProduced');
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
        case 'removed':
          // Keep the cache entry: `died` for this id may arrive in the same batch.
          break;
      }
    }
  }

  private bump(p: PlayerId, key: Exclude<keyof PlayerStats, 'player'>, by = 1): void {
    const s = this.stats.get(p);
    if (s) s[key] += by;
  }

  all(): PlayerStats[] {
    return [...this.stats.values()];
  }
}
