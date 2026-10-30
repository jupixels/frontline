import { SIM_HZ, TICK_SECONDS, type EntityId, type Vec2 } from '../../shared/types';
import type { TargetLayer, WeaponDef } from '../content';
import { dcos, dsin, headingTo, turnToward, TWO_PI, wrapAngle } from '../math/dmath';
import type { Entity, Projectile, World } from '../world';
import { hiddenFrom, smokeBlocks } from './abilities';
import { ejectAll, isPassenger } from './containers';
import { leaveLine } from './lines';
import { driveToward, followPath, nextOrder, relaxTurret, setPath } from './movement';
import { coverMult, hasLos, heightBonus } from './terrain';
import { gainXp, PRONE_DAMAGE, rankAccuracy, suppress } from './veterancy';

/** Re-evaluate auto-targets this often (staggered by entity id). */
const RETARGET_TICKS = 10;
/** Chasers refresh their path to a moving target this often. */
const CHASE_REPATH_TICKS = 20;
const TURRET_CONE = 0.08;
const HULL_CONE = 0.2;
/** Throttle for underAttack alerts per player. */
const ALERT_TICKS = SIM_HZ * 10;
/** Indirect shells hang in the air at least this long, so the target marker gives warning. */
const MIN_INDIRECT_FLIGHT = SIM_HZ;

function canHit(w: WeaponDef, layer: TargetLayer): boolean {
  return w.targets.includes(layer);
}

/** Damage multiplier of `w` against `t` (armor table, and submerged submarines shrug off all but torpedoes). */
function mult(world: World, w: WeaponDef, t: Entity): number {
  const m = world.content.damage[w.damageType][t.armor] ?? 1;
  return t.unit?.submerged && w.damageType !== 'torpedo' ? m * 0.15 : m;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Longest range among weapons that can hit `t` (0 if none), with the high-ground bonus. */
function rangeVs(world: World, e: Entity, t: Entity): number {
  let r = 0;
  // Close to the range of weapons that actually hurt it (a destroyer closes in to use depth charges).
  let best = 0;
  for (const w of e.weapons) if (canHit(w.def, t.layer)) best = Math.max(best, mult(world, w.def, t));
  for (const w of e.weapons) if (canHit(w.def, t.layer) && mult(world, w.def, t) >= best * 0.5 && w.def.range > r) r = w.def.range;
  return r > 0 ? r * heightBonus(world, e, t) : 0;
}

/** Has a lobbed weapon that can hit `t` (fires on team vision, no line of sight needed). */
function indirectVs(e: Entity, t: Entity): boolean {
  for (const w of e.weapons) if (w.def.delivery === 'indirect' && canHit(w.def, t.layer)) return true;
  return false;
}

function maxRange(e: Entity): number {
  let r = 0;
  for (const w of e.weapons) if (w.def.range > r) r = w.def.range;
  return r;
}

function bestMultiplier(world: World, e: Entity, t: Entity): number {
  let m = 0;
  for (const w of e.weapons) {
    if (!canHit(w.def, t.layer)) continue;
    const v = mult(world, w.def, t);
    if (v > m) m = v;
  }
  return m;
}

/** Structures with weapons need to be complete and (for defenses) powered. Passengers can't fire. */
function armed(world: World, e: Entity): boolean {
  if (e.weapons.length === 0 || e.dead || isPassenger(world, e)) return false;
  if (e.kind === 'structure') {
    if (e.buildProgress < 1) return false;
    const p = world.players.get(e.owner);
    if (p && p.power < 0) return false;
  }
  return e.kind !== 'point';
}

function validTarget(world: World, e: Entity, t: Entity | undefined): t is Entity {
  return !!t && !t.dead && t.kind !== 'point' && world.areEnemies(e.team, t.team) && bestMultiplier(world, e, t) > 0;
}

/** Visible to `e`'s team, not ambush-hidden, not behind smoke, and in line of sight for direct fire. */
function canSeeTarget(world: World, e: Entity, t: Entity): boolean {
  if (t.inside) return false;
  if (!world.fog.teamVisible(e.team, t.pos.x, t.pos.z) || hiddenFrom(world, t, e.team) || smokeBlocks(world, e.pos, t.pos)) return false;
  return indirectVs(e, t) || hasLos(world, e, t);
}

/** Nearest worthwhile visible enemy within `range`. Prefers units, then what our weapons hurt most. */
function acquire(world: World, e: Entity, range: number): EntityId {
  let best = 0;
  let bestScore = Infinity;
  world.spatial.query(e.pos.x, e.pos.z, range, (t, d2) => {
    if (!validTarget(world, e, t)) return;
    const rv = rangeVs(world, e, t);
    if (d2 > rv * rv && d2 > e.sight * e.sight) return;
    // Garrisoned buildings are worth shooting at (they hold infantry); empty ones much less.
    const structMult = t.kind === 'structure' ? (t.cargo.length ? 1.5 : 3) : 1;
    const score = (Math.sqrt(d2) / (0.25 + bestMultiplier(world, e, t))) * structMult;
    if (!(score < bestScore || (score === bestScore && t.id < best))) return;
    if (!canSeeTarget(world, e, t)) return;
    bestScore = score;
    best = t.id;
  });
  return best;
}

/**
 * Picks targets and moves units that are engaging (chasing into range, facing hull weapons).
 * Runs before movementSystem; units it drives are marked `busy` so movement skips them.
 */
export function targetingSystem(world: World): void {
  world.rebuildSpatial();
  for (const e of world.entities.values()) {
    e.busy = false;
    e.moving = false;
    if (!armed(world, e)) {
      if (e.kind === 'unit' && e.order?.kind === 'attack') nextOrder(e);
      continue;
    }
    const o = e.order;
    let forced = false;
    if (o?.kind === 'attack') {
      const t = world.entities.get(o.targetId);
      if (!t || t.dead) {
        nextOrder(e);
        e.target = 0;
      } else {
        e.target = t.id;
        forced = true;
      }
    }
    const isUnit = e.kind === 'unit' && !e.inside;
    const cur = e.order;
    const dug = e.entrench !== 'none';
    const engages = isUnit && !dug && (!cur || cur.kind === 'attack' || cur.kind === 'patrol' || (cur.kind === 'move' && cur.attackMove));
    // High ground can stretch range by up to 25%, so look that far for targets.
    const mr = maxRange(e) * (world.fog.traced && e.domain !== 'air' ? 1.25 : 1);
    const acqRange = engages ? Math.max(mr, e.sight) : mr;

    if (!forced) {
      const t = world.entities.get(e.target);
      const stillOk = validTarget(world, e, t) && dist2(e.pos, t.pos) <= acqRange * acqRange && canSeeTarget(world, e, t);
      if (!stillOk || (world.tick + e.id) % RETARGET_TICKS === 0) e.target = acquire(world, e, acqRange);
    }

    if (!isUnit) continue;
    const t = e.target ? world.entities.get(e.target) : undefined;

    // Idle units drift back to where they were told to stand after a chase.
    if (!cur && e.guard) {
      const leash = Math.max(40, mr * 1.5);
      if (t && dist2(t.pos, e.guard) > leash * leash) e.target = 0;
      if (!e.target) {
        if (dist2(e.pos, e.guard) > 9) {
          if (!e.path || e.chasing || e.path.goal.x !== e.guard.x || e.path.goal.z !== e.guard.z) setPath(world, e, e.guard);
          e.chasing = false;
          e.busy = true;
          if (followPath(world, e, 2)) e.path = null;
        }
        continue;
      }
    }
    if (!t) continue;

    const d = Math.sqrt(dist2(e.pos, t.pos));
    const range = rangeVs(world, e, t);
    const hold = cur?.kind === 'hold' || cur?.kind === 'line' || dug;
    // A forced target out of sight: close in until there's a line of fire.
    const blind = forced && !indirectVs(e, t) && !hasLosCached(world, e, t);
    if (engages && (d > range * 0.92 || blind)) {
      e.busy = true;
      if (!e.path || !e.chasing || world.tick % CHASE_REPATH_TICKS === e.id % CHASE_REPATH_TICKS) setPath(world, e, t.pos);
      e.chasing = true;
      followPath(world, e, range * 0.85);
    } else if (engages || hold) {
      // In range: face the target if any hull-mounted weapon can hit it.
      const hull = e.weapons.some((w) => w.def.mount === 'hull' && canHit(w.def, t.layer));
      if (hull) {
        e.busy = true;
        if (e.unit!.domain === 'air' && d < range * 0.3) driveToward(world, e, t.pos, 0);
        else e.heading = turnToward(e.heading, headingTo(t.pos.x - e.pos.x, t.pos.z - e.pos.z), e.unit!.turnRate * TICK_SECONDS);
      } else if (engages) e.busy = true;
    }
  }
}

/** Aims turrets and fires every ready weapon at the current target. Runs after movement. */
export function weaponsSystem(world: World): void {
  for (const e of world.entities.values()) {
    if (!armed(world, e)) continue;
    for (const w of e.weapons) if (w.cooldown > 0) w.cooldown--;
    const t = e.target ? world.entities.get(e.target) : undefined;
    if (!t || t.dead) {
      relaxTurret(e);
      continue;
    }
    const dx = t.pos.x - e.pos.x;
    const dz = t.pos.z - e.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const bearing = headingTo(dx, dz);
    const bonus = heightBonus(world, e, t);
    const garrisoned = e.inside !== 0;
    if (t.inside || (e.kind === 'unit' && !hasLosCached(world, e, t))) {
      relaxTurret(e);
      continue;
    }
    if (e.turretHeading !== undefined) {
      const rate = e.unit?.turretTurnRate ?? 2.5;
      e.turretHeading = turnToward(e.turretHeading, bearing, rate * TICK_SECONDS);
    }
    for (const w of e.weapons) {
      const def = w.def;
      if (w.cooldown > 0 || !canHit(def, t.layer) || d > def.range * bonus || d < (def.minRange ?? 0)) continue;
      if (garrisoned) {
        // Firing out of a building or trench: no turning needed.
      } else if (def.mount === 'turret') {
        if (e.turretHeading !== undefined && Math.abs(wrapAngle(bearing - e.turretHeading)) > TURRET_CONE) continue;
      } else {
        if (Math.abs(wrapAngle(bearing - e.heading)) > HULL_CONE) continue;
        if (e.moving && e.domain !== 'air') continue;
      }
      if (world.content.damage[def.damageType][t.armor] <= 0) continue;
      fire(world, e, w.id, def, t, d);
      // Units far from supply (low readiness) reload slower.
      w.cooldown = Math.max(1, Math.round((def.reload * SIM_HZ) / e.readiness));
    }
  }
}

/** Fire an indirect shell at a ground point (weapons and barrages). */
export function launchIndirect(world: World, e: Entity, weapon: string, def: WeaponDef, at: Vec2, mult = 1): void {
  const dx = at.x - e.pos.x;
  const dz = at.z - e.pos.z;
  const flight = Math.max(MIN_INDIRECT_FLIGHT, Math.ceil((Math.sqrt(dx * dx + dz * dz) / (def.projectileSpeed ?? 100)) * SIM_HZ));
  world.emit({ type: 'fired', id: e.id, weapon, at: { x: at.x, z: at.z } });
  world.proposed.push({ type: 'incoming', weapon, by: e.id, at: { x: at.x, z: at.z }, radius: def.splash ?? 0, arrive: world.tick + flight });
  world.projectiles.push({
    weapon,
    def,
    shooter: e.id,
    owner: e.owner,
    team: e.team,
    from: { x: e.pos.x, z: e.pos.z },
    at: { x: at.x, z: at.z },
    targetId: 0,
    hits: false,
    arrive: world.tick + flight,
    mult,
  });
}

/** Line of fire for direct weapons, re-checked every few ticks per shooter (it's the costly part). */
function hasLosCached(world: World, e: Entity, t: Entity): boolean {
  if (e.losTarget === t.id && world.tick - e.losAt < 5 && world.tick >= e.losAt) return e.losOk;
  e.losTarget = t.id;
  e.losAt = world.tick;
  e.losOk = indirectVs(e, t) || hasLos(world, e, t);
  return e.losOk;
}

function fire(world: World, e: Entity, weapon: string, def: WeaponDef, t: Entity, d: number): void {
  const at = { x: t.pos.x, z: t.pos.z };
  e.firedAt = world.tick;
  let mult = 1;
  if (e.ambush) {
    // Springing an ambush: bonus first shot, then visible.
    mult = e.ambushBonus;
    e.ambush = false;
    world.proposed.push({ type: 'revealed', id: e.id });
  }
  // Readiness: low readiness costs accuracy; veterans shoot better, pinned infantry much worse.
  const accuracy = Math.min(0.98, def.accuracy * (0.6 + 0.4 * e.readiness) * rankAccuracy(e) * (e.pinned ? 0.5 : 1));
  if (def.delivery === 'hitscan') {
    world.emit({ type: 'fired', id: e.id, weapon, target: t.id, at });
    if (world.rng.next() < accuracy) applyDamage(world, t, def.damage * mult, def, e.pos, e.id);
    else suppress(world, t, def, 1 / 3);
    return;
  }
  if (def.delivery === 'indirect') {
    const s = def.scatter ?? 0;
    const ang = world.rng.next() * TWO_PI;
    const r = s * Math.sqrt(world.rng.next());
    launchIndirect(world, e, weapon, def, { x: at.x + dsin(ang) * r, z: at.z + dcos(ang) * r }, mult);
    return;
  }
  const flight = Math.max(1, Math.ceil((d / (def.projectileSpeed ?? 100)) * SIM_HZ));
  world.emit({ type: 'fired', id: e.id, weapon, target: t.id, at });
  const p: Projectile = {
    weapon,
    def,
    shooter: e.id,
    owner: e.owner,
    team: e.team,
    from: { x: e.pos.x, z: e.pos.z },
    at,
    targetId: t.id,
    hits: world.rng.next() < accuracy,
    arrive: world.tick + flight,
    mult,
  };
  world.projectiles.push(p);
}

/** Lands projectiles whose flight time is up. */
export function projectileSystem(world: World): void {
  if (world.projectiles.length === 0) return;
  const keep: Projectile[] = [];
  for (const p of world.projectiles) {
    if (p.arrive > world.tick) {
      keep.push(p);
      continue;
    }
    const t = p.targetId ? world.entities.get(p.targetId) : undefined;
    let at = p.at;
    let direct: Entity | undefined;
    if (p.hits && t && !t.dead) {
      at = { x: t.pos.x, z: t.pos.z };
      direct = t;
      applyDamage(world, t, p.def.damage * p.mult, p.def, p.from, p.shooter);
    } else if (t && !t.dead && p.def.delivery !== 'indirect') {
      // A miss lands near where the target was aimed at.
      at = { x: p.at.x + (world.rng.next() - 0.5) * 6, z: p.at.z + (world.rng.next() - 0.5) * 6 };
      suppress(world, t, p.def, 1 / 3);
    }
    world.emit({ type: 'impact', weapon: p.weapon, at });
    if (p.def.splash) splash(world, p, at, direct);
  }
  world.projectiles = keep;
}

function splash(world: World, p: Projectile, at: Vec2, skip: Entity | undefined): void {
  const r = p.def.splash!;
  const victims: Entity[] = [];
  world.spatial.query(at.x, at.z, r + 12, (v) => {
    if (v === skip || v.dead || !world.areEnemies(p.team, v.team)) return;
    if (v.layer === 'air' && !p.def.targets.includes('air')) return;
    victims.push(v);
  });
  victims.sort((a, b) => a.id - b.id);
  for (const v of victims) {
    const dx = v.pos.x - at.x;
    const dz = v.pos.z - at.z;
    const d = Math.max(0, Math.sqrt(dx * dx + dz * dz) - v.radius);
    if (d > r) continue;
    applyDamage(world, v, p.def.damage * p.mult * (1 - (0.5 * d) / r), p.def, p.from, p.shooter);
  }
}

function facingMultiplier(t: Entity, from: Vec2): number {
  const f = t.unit?.facing;
  if (!f) return 1;
  const dx = from.x - t.pos.x;
  const dz = from.z - t.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return f.side;
  const dot = (dx / d) * dsin(t.heading) + (dz / d) * dcos(t.heading);
  if (dot > 0.7071) return f.front;
  if (dot < -0.7071) return f.rear;
  return f.side;
}

/** Damage after armor class, facing and sudden-death modifiers. Marks the target dead at 0 hp. */
export function applyDamage(world: World, t: Entity, base: number, def: WeaponDef, from: Vec2, by?: EntityId): void {
  if (t.dead || t.kind === 'point') return;
  let mult = world.content.damage[def.damageType][t.armor] ?? 1;
  if (def.damageType !== 'aa' && def.damageType !== 'torpedo') mult *= facingMultiplier(t, from);
  if (t.entrench === 'entrenched') mult *= t.entrenchDamage;
  if (t.type === 'hq' && world.suddenDeath) mult *= world.content.rules.suddenDeathHqDamageMult;
  mult *= coverMult(world, t, def);
  // Submerged submarines are only really hurt by torpedoes and depth charges.
  if (t.unit?.submerged && def.damageType !== 'torpedo') mult *= 0.15;
  if (t.pinned && (def.damageType === 'small_arms' || def.damageType === 'he')) mult *= PRONE_DAMAGE;
  const dmg = base * mult;
  if (dmg <= 0) return;
  const dealt = Math.min(dmg, t.hp);
  t.hp -= dmg;
  t.hurtAt = world.tick;
  world.emit({ type: 'hit', id: t.id, by, damage: dmg, at: { x: t.pos.x, z: t.pos.z } });
  suppress(world, t, def, 1);
  if (by !== undefined) gainXp(world, by, t, dealt);
  const owner = world.players.get(t.owner);
  if (owner && world.tick - owner.lastAlertTick >= ALERT_TICKS) {
    owner.lastAlertTick = world.tick;
    world.emit({ type: 'underAttack', player: owner.id, at: { x: t.pos.x, z: t.pos.z } });
  }
  if (t.hp <= 0) {
    t.hp = 0;
    t.dead = true;
    t.killer = by;
  }
}

/** Removes dead entities: died + removed events, morale cost for lost units. */
export function deathSystem(world: World): void {
  // Containers first: their cargo bails out (buildings, IFVs) or goes down with them (helis, ships).
  for (const e of world.entities.values()) if (e.dead && e.cargo.length) ejectAll(world, e, true);
  const dead: Entity[] = [];
  for (const e of world.entities.values()) if (e.dead) dead.push(e);
  for (const e of dead) {
    if (e.line) leaveLine(world, e);
    world.emit({ type: 'died', id: e.id, killer: e.killer });

    if (e.kind === 'unit' && !world.players.get(e.owner)?.defeated) {
      const team = world.teams.get(e.team);
      if (team) team.morale -= e.cp * world.content.rules.unitLossMoralePerCp;
    }
    world.remove(e.id);
  }
}
