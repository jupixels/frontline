// Suppression (infantry under fire go prone: slow, inaccurate, harder to hit) and veterancy
// (three ranks earned by dealing damage: accuracy, health, and self-heal at rank 3).

import { SUPPRESS_PINNED } from '../../shared/entities';
import { SIM_HZ, type EntityId } from '../../shared/types';
import type { WeaponDef } from '../content';
import type { Entity, World } from '../world';

/** Pinned infantry recover once suppression falls below this. */
const SUPPRESS_RECOVER = 0.25;
/** Suppression starts to fade this long after the last hit. */
const SUPPRESS_HOLD_TICKS = SIM_HZ * 2;
const SUPPRESS_DECAY_PER_SEC = 0.22;
/** Damage taken from small arms and HE while prone. */
export const PRONE_DAMAGE = 0.75;
/** Speed while pinned. */
export const PINNED_SPEED = 0.45;

/** Experience for each rank, in multiples of the unit's own value. */
const RANK_XP = [1, 2.5, 5];
const RANK_HP = 0.1;
const RANK_ACCURACY = 0.1;
/** Rank 3 heals this fraction of max hp per second after this long without damage. */
const HEAL_PER_SEC = 0.012;
const HEAL_QUIET_TICKS = SIM_HZ * 6;

/** Default suppression per hit by damage type (weapons can override with `suppression`). */
const DEFAULT_SUPPRESSION: Record<string, number> = { small_arms: 0.07, he: 0.22, ap: 0.04, aa: 0.05, torpedo: 0 };

/** Supply value of one entity (a squad member is worth its share of the squad). */
export function valueOf(e: Entity): number {
  if (e.unit) return Math.max(40, e.unit.cost / (e.unit.squad ?? 1));
  if (e.structure) return Math.max(100, e.structure.cost);
  return 50;
}

export function rankAccuracy(e: Entity): number {
  return 1 + RANK_ACCURACY * e.rank;
}

/** Add suppression to infantry hit (or nearly hit) by `def`. */
export function suppress(world: World, t: Entity, def: WeaponDef, scale: number): void {
  if (t.armor !== 'infantry' || t.kind !== 'unit' || t.dead || t.inside) return;
  let s = (def.suppression ?? DEFAULT_SUPPRESSION[def.damageType] ?? 0) * scale;
  if (s <= 0) return;
  if (t.entrench === 'entrenched') s *= 0.5;
  s *= 1 - 0.15 * t.rank;
  t.suppression = Math.min(1, t.suppression + s);
  t.suppressedAt = world.tick;
  if (!t.pinned && t.suppression >= SUPPRESS_PINNED) {
    t.pinned = true;
    world.emit({ type: 'suppressed', id: t.id, pinned: true });
  }
}

/** Experience for the shooter `by` from dealing `dmg` to `t`, weighted by what `t` is worth. */
export function gainXp(world: World, by: EntityId, t: Entity, dmg: number): void {
  if (dmg <= 0 || t.maxHp <= 0) return;
  const s = world.entities.get(by);
  if (!s || s.kind !== 'unit' || s.dead || s.rank >= 3 || !world.areEnemies(s.team, t.team)) return;
  s.xp += (dmg / t.maxHp) * valueOf(t);
  while (s.rank < 3 && s.xp >= RANK_XP[s.rank] * valueOf(s)) {
    s.rank++;
    const grow = (1 + RANK_HP * s.rank) / (1 + RANK_HP * (s.rank - 1));
    s.maxHp *= grow;
    s.hp *= grow;
    world.emit({ type: 'promoted', id: s.id, rank: s.rank });
  }
}

/** Suppression decay and veteran self-heal. */
export function veterancySystem(world: World): void {
  const decay = SUPPRESS_DECAY_PER_SEC / SIM_HZ;
  for (const e of world.entities.values()) {
    if (e.kind !== 'unit' || e.dead) continue;
    if (e.suppression > 0 && world.tick - e.suppressedAt > SUPPRESS_HOLD_TICKS) {
      // A shaken side (low Morale) takes longer to shake off suppression.
      const shaken = world.teams.get(e.team)?.moraleLow ? (world.content.rules.moraleLowRecovery ?? 0.6) : 1;
      e.suppression = Math.max(0, e.suppression - decay * shaken);
      if (e.pinned && e.suppression < SUPPRESS_RECOVER) {
        e.pinned = false;
        world.emit({ type: 'suppressed', id: e.id, pinned: false });
      }
    }
    if (e.rank >= 3 && e.hp < e.maxHp && world.tick - e.hurtAt > HEAL_QUIET_TICKS) {
      e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * HEAL_PER_SEC) / SIM_HZ);
    }
  }
}
