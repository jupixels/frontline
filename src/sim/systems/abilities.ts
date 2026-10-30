import { SIM_HZ, type EntityId, type PlayerId, type TeamId, type Vec2 } from '../../shared/types';
import type { AbilityDef } from '../content';
import { dcos, dsin, TWO_PI } from '../math/dmath';
import type { AbilityState, Entity, World } from '../world';
import { launchIndirect } from './combat';
import { followPath, nextOrder, setPath } from './movement';

const ticks = (seconds: number | undefined) => Math.max(1, Math.round((seconds ?? 0) * SIM_HZ));

function abilityOf(e: Entity, id: string): AbilityState | undefined {
  return e.abilities.find((a) => a.id === id);
}

function blocked(world: World, player: PlayerId, reason: 'supply' | 'requirements'): void {
  world.proposed.push({ type: 'blocked', player, reason });
}

/** Pay the cost from the caster's owner. False (and a `blocked` event to `issuer`) if short. */
function pay(world: World, issuer: PlayerId, e: Entity, def: AbilityDef): boolean {
  if (!def.cost) return true;
  const p = world.players.get(e.owner);
  if (!p || p.supply < def.cost) {
    blocked(world, issuer, 'supply');
    return false;
  }
  p.supply -= def.cost;
  return true;
}

function castRange(e: Entity, def: AbilityDef): number {
  if (def.range > 0) return def.range;
  let r = 0;
  for (const w of e.weapons) if (w.def.range > r) r = w.def.range;
  return r;
}

/** Entrenched/deploying infantry start packing up (they can't move until done). */
export function packUp(e: Entity): void {
  if (e.entrench === 'deploying' || e.entrench === 'entrenched') {
    e.entrench = 'packing';
    e.entrenchAt = -1; // abilitySystem starts the timer (it knows the tick)
    e.entrenchDamage = 1;
  }
}

/** `useAbility` command. Self abilities fire now; point/unit abilities become an order. */
export function orderAbility(world: World, player: PlayerId, units: Entity[], ability: string, at: Vec2 | undefined, targetId: EntityId | undefined, queue: boolean): void {
  const def = world.content.abilities[ability];
  if (!def) return;
  let target: Entity | undefined;
  if (def.target === 'unit') {
    target = targetId !== undefined ? world.entities.get(targetId) : undefined;
    if (!target || target.dead) return;
  }
  if (def.target === 'point' && !at) return;
  let casters = units.filter((u) => {
    const a = abilityOf(u, ability);
    return a && a.cooldown === 0;
  });
  // Area abilities without per-unit value (smoke) use one caster: the closest to the target.
  if (def.single && casters.length > 1 && at) {
    let best = casters[0];
    let bestD = Infinity;
    for (const u of casters) {
      const d = (u.pos.x - at.x) * (u.pos.x - at.x) + (u.pos.z - at.z) * (u.pos.z - at.z);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    casters = [best];
  }
  if (!casters.length) return;
  for (const u of casters) {
    if (def.target === 'self') {
      castSelf(world, player, u, ability, def);
      continue;
    }
    const point = target ? { x: target.pos.x, z: target.pos.z } : { x: at!.x, z: at!.z };
    const order = { kind: 'ability' as const, ability, at: point, targetId: target?.id ?? 0 };
    if (queue && u.order) u.orderQueue.push(order);
    else {
      packUp(u);
      u.order = order;
      u.orderQueue.length = 0;
      u.path = null;
      u.chasing = false;
      u.target = 0;
      u.guard = null;
    }
  }
  world.emit({ type: 'ordered', player, units: casters.map((u) => u.id), order: 'attack' });
}

function castSelf(world: World, player: PlayerId, e: Entity, id: string, def: AbilityDef): void {
  const a = abilityOf(e, id)!;
  if (id === 'entrench') {
    if (e.entrench === 'none') {
      e.entrench = 'deploying';
      e.entrenchAt = world.tick + ticks(def.deploySeconds);
      e.order = { kind: 'hold' };
      e.orderQueue.length = 0;
      e.path = null;
      world.proposed.push({ type: 'entrench', id: e.id, state: 'deploying' });
    } else if (e.entrench !== 'packing') {
      packUp(e);
    } else return;
  } else if (id === 'ambush') {
    e.ambush = !e.ambush;
    e.ambushBonus = def.firstShotMult ?? 1;
    if (!e.ambush) world.proposed.push({ type: 'revealed', id: e.id });
  } else if (def.speedMult) {
    if (!pay(world, player, e, def)) return;
    e.boostUntil = world.tick + ticks(def.duration);
    e.boostMult = def.speedMult;
  } else return;
  a.cooldown = ticks(def.cooldown);
  world.proposed.push({ type: 'abilityUsed', id: e.id, ability: id });
}

/** One tick of a unit carrying out a point/unit ability order (called from movementSystem). */
export function abilityOrderTick(world: World, e: Entity, o: { ability: string; at: Vec2; targetId: EntityId }): void {
  const a = abilityOf(e, o.ability);
  if (!a) {
    nextOrder(e);
    return;
  }
  const def = a.def;
  let at = o.at;
  if (def.target === 'unit') {
    const t = world.entities.get(o.targetId);
    if (!t || t.dead) {
      nextOrder(e);
      return;
    }
    at = t.pos;
  }
  const range = castRange(e, def);
  const dx = at.x - e.pos.x;
  const dz = at.z - e.pos.z;
  if (dx * dx + dz * dz > range * range) {
    if (!e.path) setPath(world, e, at);
    followPath(world, e, range * 0.95);
    return;
  }
  e.path = null;
  if (a.cooldown > 0) return; // wait in range until ready
  if (def.requiresVision && !world.fog.teamVisible(e.team, at.x, at.z)) {
    blocked(world, e.owner, 'requirements');
    nextOrder(e);
    return;
  }
  if (!castAt(world, e, o.ability, def, at)) {
    nextOrder(e);
    return;
  }
  a.cooldown = ticks(def.cooldown);
  world.proposed.push({ type: 'abilityUsed', id: e.id, ability: o.ability, at: { x: at.x, z: at.z }, targetId: o.targetId || undefined });
  nextOrder(e);
}

function castAt(world: World, e: Entity, id: string, def: AbilityDef, at: Vec2): boolean {
  if (id === 'smoke') {
    if (!pay(world, e.owner, e, def)) return false;
    const s = { at: { x: at.x, z: at.z }, radius: def.radius ?? 10, until: world.tick + ticks(def.duration) };
    world.smokes.push(s);
    world.proposed.push({ type: 'smoke', at: s.at, radius: s.radius, until: s.until });
    return true;
  }
  if (id === 'barrage') {
    const w = e.weapons.find((x) => x.def.delivery === 'indirect');
    if (!w) return false;
    if (!pay(world, e.owner, e, def)) return false;
    world.barrages.push({ caster: e.id, weapon: w.id, at: { x: at.x, z: at.z }, radius: def.radius ?? 20, left: def.shots ?? 4, next: world.tick, interval: ticks(def.interval) });
    return true;
  }
  return false;
}

/** Cooldowns, timed states (entrench, ambush), smoke expiry and barrage shells. */
export function abilitySystem(world: World): void {
  for (const e of world.entities.values()) {
    if (e.kind !== 'unit' || e.dead) continue;
    for (const a of e.abilities) if (a.cooldown > 0) a.cooldown--;
    if (e.entrench !== 'none') {
      if (e.entrenchAt < 0) {
        e.entrenchAt = world.tick + ticks(abilityOf(e, 'entrench')?.def.packSeconds);
      } else if (world.tick >= e.entrenchAt) {
        if (e.entrench === 'deploying') {
          e.entrench = 'entrenched';
          e.entrenchDamage = abilityOf(e, 'entrench')?.def.damageTaken ?? 1;
          world.proposed.push({ type: 'entrench', id: e.id, state: 'entrenched' });
        } else if (e.entrench === 'packing') {
          e.entrench = 'none';
          world.proposed.push({ type: 'entrench', id: e.id, state: 'none' });
        }
      }
    }
    if (e.ambush && e.moving) {
      e.ambush = false;
      world.proposed.push({ type: 'revealed', id: e.id });
    }
  }

  if (world.smokes.length) world.smokes = world.smokes.filter((s) => s.until > world.tick);

  if (world.barrages.length) {
    const keep = [];
    for (const b of world.barrages) {
      const caster = world.entities.get(b.caster);
      if (!caster || caster.dead) continue;
      if (world.tick >= b.next) {
        const w = caster.weapons.find((x) => x.id === b.weapon)!;
        const ang = world.rng.next() * TWO_PI;
        const r = b.radius * Math.sqrt(world.rng.next());
        launchIndirect(world, caster, b.weapon, w.def, { x: b.at.x + dsin(ang) * r, z: b.at.z + dcos(ang) * r });
        b.left--;
        b.next = world.tick + b.interval;
      }
      if (b.left > 0) keep.push(b);
    }
    world.barrages = keep;
  }
}

/** Submarines show up within this range, and for this long after firing. */
const SUB_DETECT_RANGE = 60;
const SUB_REVEAL_TICKS = SIM_HZ * 4;

/** Ships with anti-submarine weapons (depth charges) hear submarines this far out. */
const SONAR_RANGE = 150;

function sonarContact(world: World, e: Entity, team: TeamId): boolean {
  let seen = false;
  world.spatial.query(e.pos.x, e.pos.z, SONAR_RANGE, (o, d2) => {
    if (o.team !== team || o.kind !== 'unit' || o.dead) return;
    if (d2 <= SUB_DETECT_RANGE * SUB_DETECT_RANGE || o.weapons.some((w) => w.def.damageType === 'torpedo' && w.def.targets.includes('naval') && w.def.range <= 80)) {
      seen = true;
      return true;
    }
  });
  return seen;
}

/** Ambushing unit hidden from `team`: armed, stationary, and no enemy of it within reveal range. */
export function hiddenFrom(world: World, e: Entity, team: TeamId): boolean {
  if (e.team === team) return false;
  // Submarines run submerged: only enemies close by see them, and firing gives them away for a while.
  if (e.unit?.submerged) {
    if (world.tick - e.firedAt < SUB_REVEAL_TICKS) return false;
    return !sonarContact(world, e, team);
  }
  if (!e.ambush || e.moving) return false;
  const r = abilityOf(e, 'ambush')?.def.revealRange ?? 15;
  let seen = false;
  world.spatial.query(e.pos.x, e.pos.z, r, (o) => {
    if (o.team === team && o.kind === 'unit' && !o.dead) {
      seen = true;
      return true;
    }
  });
  return !seen;
}

/** True if the segment a→b passes through a smoke cloud (short ranges see through). */
export function smokeBlocks(world: World, a: Vec2, b: Vec2): boolean {
  if (world.smokes.length === 0) return false;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 100) return false;
  for (const s of world.smokes) {
    let t = ((s.at.x - a.x) * dx + (s.at.z - a.z) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t - s.at.x;
    const pz = a.z + dz * t - s.at.z;
    if (px * px + pz * pz <= s.radius * s.radius) return true;
  }
  return false;
}
