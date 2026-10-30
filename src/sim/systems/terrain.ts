import type { WeaponDef } from '../content';
import { FLAG_BRIDGE, FLAG_FOREST, FLAG_ROAD, FLAG_SHALLOW } from '../path/navgrid';
import type { Entity, World } from '../world';
import { eyeHeight } from './fog';

/** Range bonus per meter the shooter stands above its target, and the cap. */
const HIGH_GROUND_PER_M = 0.012;
const HIGH_GROUND_MAX = 0.25;
/** Damage multiplier for infantry in woods (cover) against everything but torpedoes and AA. */
export const FOREST_COVER = 0.7;

/** Height of what's being aimed at (center mass). */
function targetTop(t: Entity): number {
  if (t.kind === 'structure') return 4;
  if (t.domain === 'air') return 30;
  return t.armor === 'infantry' ? 1.2 : 2;
}

/** Weapon range multiplier from high ground (ground and naval shooters only). */
export function heightBonus(world: World, e: Entity, t: Entity): number {
  if (e.domain === 'air' || t.domain === 'air' || !world.fog.traced) return 1;
  const dh = world.heightAt(e.pos.x, e.pos.z) - world.heightAt(t.pos.x, t.pos.z);
  if (dh <= 0) return 1;
  return 1 + Math.min(HIGH_GROUND_MAX, dh * HIGH_GROUND_PER_M);
}

/** Direct line of sight from `e` to `t` (terrain and woods). Aircraft see and are seen over everything. */
export function hasLos(world: World, e: Entity, t: Entity): boolean {
  if (e.domain === 'air' || t.domain === 'air' || !world.fog.traced) return true;
  return world.fog.lineOfSight(e.pos.x, e.pos.z, eyeHeight(e), t.pos.x, t.pos.z, targetTop(t));
}

/**
 * Speed multiplier for a ground unit heading along (dx, dz) (unit vector): slopes slow vehicles a lot
 * and infantry a little, roads speed vehicles up, woods and fords slow everyone.
 */
export function terrainSpeed(world: World, e: Entity, dx: number, dz: number): number {
  if (e.domain !== 'ground') return 1;
  const nav = world.nav;
  const f = nav.flagsAt(e.pos);
  const inf = e.armor === 'infantry';
  let m = 1;
  if (f & FLAG_SHALLOW) m *= inf ? 0.6 : 0.5;
  if (f & FLAG_FOREST) m *= inf ? 0.9 : 0.55;
  if (f & (FLAG_ROAD | FLAG_BRIDGE) && !inf) m *= 1.25;
  if (world.fog.traced) {
    const h0 = nav.heightAt(e.pos.x, e.pos.z);
    const h1 = nav.heightAt(e.pos.x + dx * 3, e.pos.z + dz * 3);
    const slope = (h1 - h0) / 3;
    if (slope > 0) m *= inf ? Math.max(0.65, 1 - slope * 0.8) : Math.max(0.35, 1 - slope * 1.8);
    else if (!inf) m *= 1 + Math.min(0.12, -slope * 0.4);
  }
  return m;
}

/** Damage multiplier from where the target stands: woods give infantry cover. */
export function coverMult(world: World, t: Entity, def: WeaponDef): number {
  if (t.armor !== 'infantry' || t.domain !== 'ground' || def.damageType === 'aa' || def.damageType === 'torpedo') return 1;
  return world.nav.flagsAt(t.pos) & FLAG_FOREST ? FOREST_COVER : 1;
}
