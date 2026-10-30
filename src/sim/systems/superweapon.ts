// Tier 3 superweapon: a cruise missile from the Strategic Command. It charges slowly, everyone gets
// an early warning (impact point + countdown) at launch, and the blast wrecks anything in the radius.

import { SIM_HZ, type PlayerId, type Vec2 } from '../../shared/types';
import type { WeaponDef } from '../content';
import type { Entity, World } from '../world';
import { applyDamage } from './combat';

export const MISSILE_WEAPON = 'cruise_missile';

const MISSILE_DEF: WeaponDef = {
  range: 0,
  damage: 0,
  reload: 0,
  damageType: 'he',
  delivery: 'indirect',
  targets: ['ground', 'naval'],
  mount: 'hull',
  accuracy: 1,
};

function rules(world: World) {
  const r = world.content.rules;
  return {
    charge: Math.round((r.superweaponSeconds ?? 360) * SIM_HZ),
    warning: Math.round((r.superweaponWarningSeconds ?? 12) * SIM_HZ),
    radius: r.superweaponRadius ?? 32,
    damage: r.superweaponDamage ?? 1400,
  };
}

/** The player's completed superweapon site, if any. */
export function superweaponSite(world: World, player: PlayerId): Entity | undefined {
  for (const e of world.entities.values()) {
    if (e.kind === 'structure' && e.owner === player && !e.dead && e.buildProgress >= 1 && e.structure?.superweapon) return e;
  }
  return undefined;
}

export function superweaponStatus(world: World, player: PlayerId): { site: number; charge: number; ready: boolean } | null {
  const site = superweaponSite(world, player);
  const p = world.players.get(player);
  if (!site || !p) return null;
  const full = rules(world).charge;
  return { site: site.id, charge: Math.min(1, p.superCharge / full), ready: p.superCharge >= full };
}

/** `superweapon` command. */
export function orderSuperweapon(world: World, player: PlayerId, at: Vec2): void {
  const p = world.players.get(player);
  const site = superweaponSite(world, player);
  const r = rules(world);
  if (!p || !site || p.superCharge < r.charge) {
    world.emit({ type: 'blocked', player, reason: 'requirements' });
    return;
  }
  const half = world.map.size / 2;
  const target = { x: Math.max(-half, Math.min(half, at.x)), z: Math.max(-half, Math.min(half, at.z)) };
  p.superCharge = 0;
  p.superReadyAnnounced = false;
  const arrive = world.tick + r.warning;
  world.missiles.push({ player, team: p.team, site: site.id, at: target, arrive });
  world.emit({ type: 'superweaponLaunched', player, site: site.id, at: target, radius: r.radius, arrive });
}

/** Charging (needs power) and missile impacts. */
export function superweaponSystem(world: World): void {
  const r = rules(world);
  for (const p of world.players.values()) {
    if (p.defeated) continue;
    const site = superweaponSite(world, p.id);
    if (!site) {
      p.superCharge = 0;
      continue;
    }
    if (p.power >= 0 && p.superCharge < r.charge) p.superCharge++;
    if (p.superCharge >= r.charge && !p.superReadyAnnounced) {
      p.superReadyAnnounced = true;
      world.emit({ type: 'superweaponReady', player: p.id });
    }
  }
  if (!world.missiles.length) return;
  const keep = [];
  for (const m of world.missiles) {
    if (m.arrive > world.tick) {
      keep.push(m);
      continue;
    }
    world.emit({ type: 'impact', weapon: MISSILE_WEAPON, at: m.at });
    world.emit({ type: 'superweaponImpact', player: m.player, at: m.at, radius: r.radius });
    const victims: Entity[] = [];
    world.spatial.query(m.at.x, m.at.z, r.radius + 15, (v) => {
      if (!v.dead && v.layer !== 'air' && world.areEnemies(m.team, v.team)) victims.push(v);
    });
    victims.sort((a, b) => a.id - b.id);
    for (const v of victims) {
      const dx = v.pos.x - m.at.x;
      const dz = v.pos.z - m.at.z;
      const d = Math.max(0, Math.sqrt(dx * dx + dz * dz) - v.radius);
      if (d > r.radius) continue;
      applyDamage(world, v, r.damage * (1 - (0.6 * d) / r.radius), MISSILE_DEF, m.at, m.site);
    }
  }
  world.missiles = keep;
}
