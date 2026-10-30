import { MAX_PLAYERS, NEUTRAL, SIM_HZ, type PlayerId, type TeamId } from '../../shared/types';
import type { Entity, World } from '../world';

/**
 * Capture points: progress moves only while exactly one team has ground/naval units in radius.
 * An owned point must be neutralized (progress back to 0) before another team can take it.
 */
export function captureSystem(world: World): void {
  const rules = world.content.rules;
  const perPlayer = new Array<number>(MAX_PLAYERS);
  for (const p of world.players.values()) p.pointsHeld = 0;

  for (const pt of world.entities.values()) {
    if (pt.kind !== 'point') continue;
    perPlayer.fill(0);
    let team: TeamId = -1;
    let contested = false;
    world.spatial.query(pt.pos.x, pt.pos.z, pt.captureRadius, (u) => {
      if (u.kind !== 'unit' || u.dead || u.domain === 'air' || u.owner < 0 || u.unit?.logistics) return;
      const pl = world.players.get(u.owner);
      if (!pl || pl.defeated) return;
      perPlayer[u.owner]++;
      if (team === -1) team = u.team;
      else if (team !== u.team) contested = true;
    });
    if (team !== -1 && !contested) stepPoint(world, pt, team, perPlayer, rules.captureSeconds);
    pt.hp = pt.captureProgress * 100;
    const owner = world.players.get(pt.owner);
    if (owner) owner.pointsHeld++;
  }
}

function stepPoint(world: World, pt: Entity, team: TeamId, perPlayer: number[], captureSeconds: number): void {
  // Leading capturer on that team: most units, lowest id on ties.
  let lead: PlayerId = NEUTRAL;
  let n = 0;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (perPlayer[i] > n && world.teamOf(i) === team) {
      n = perPlayer[i];
      lead = i;
    }
  }
  const rate = (1 + 0.25 * (Math.min(n, 5) - 1)) / (captureSeconds * SIM_HZ);
  const ownerTeam = pt.owner === NEUTRAL ? -1 : world.teamOf(pt.owner);
  if (ownerTeam === team) {
    pt.captureProgress = Math.min(1, pt.captureProgress + rate);
    return;
  }
  if (pt.owner !== NEUTRAL) {
    pt.captureProgress -= rate;
    if (pt.captureProgress <= 0) {
      world.proposed.push({ type: 'neutralized', point: pt.id, from: pt.owner });
      pt.captureProgress = 0;
      pt.owner = NEUTRAL;
      pt.team = -1;
      pt.capturer = lead;
      pt.stock = 0;
      pt.truck = 0;
    }
    return;
  }
  const capTeam = pt.capturer === NEUTRAL ? -1 : world.teamOf(pt.capturer);
  if (capTeam !== team) {
    pt.captureProgress -= rate;
    if (pt.captureProgress <= 0) {
      pt.captureProgress = 0;
      pt.capturer = lead;
    }
    return;
  }
  pt.captureProgress += rate;
  if (pt.captureProgress >= 1) {
    pt.captureProgress = 1;
    pt.owner = pt.capturer;
    pt.team = team;
    pt.stock = 0;
    pt.truck = 0;
    pt.truckReadyAt = 0;
    world.emit({ type: 'captured', point: pt.id, by: pt.owner });
  }
}

/** Ticket bleed, sudden death, defeat and victory. */
export function victorySystem(world: World): void {
  if (world.over) return;
  const rules = world.content.rules;
  const frontline = world.setup.victory === 'frontline';
  const secs = world.seconds();

  if (!world.suddenDeath && secs >= rules.suddenDeathSeconds) {
    world.suddenDeath = true;
    world.proposed.push({ type: 'suddenDeath', tick: world.tick });
  }

  if (frontline) {
    const held = new Map<TeamId, number>();
    for (const t of world.teams.values()) held.set(t.id, 0);
    for (const e of world.entities.values()) if (e.kind === 'point' && e.team >= 0) held.set(e.team, (held.get(e.team) ?? 0) + 1);
    let lead = 0;
    for (const n of held.values()) if (n > lead) lead = n;
    const late = secs >= rules.lateBleedSeconds ? rules.lateBleedMult : 1;
    for (const t of world.teams.values()) {
      if (t.defeated) continue;
      let bleed = rules.bleedPerPointDiff * (lead - (held.get(t.id) ?? 0)) * late;
      if (world.suddenDeath) bleed += rules.suddenDeathBleed;
      t.tickets -= bleed / SIM_HZ;
    }
  }

  // Per-player defeat checks.
  const hasHq = new Set<PlayerId>();
  const hasProduction = new Set<PlayerId>();
  const hasAnything = new Set<PlayerId>();
  for (const e of world.entities.values()) {
    if (e.dead || e.owner < 0) continue;
    hasAnything.add(e.owner);
    if (e.kind !== 'structure') continue;
    if (e.type === 'hq') hasHq.add(e.owner);
    if (e.structure!.production) hasProduction.add(e.owner);
  }
  for (const p of world.players.values()) {
    const team = world.teams.get(p.team)!;
    if (p.defeated) {
      p.tickets = team.tickets;
      continue;
    }
    let lost = !hasAnything.has(p.id);
    if (frontline) lost ||= team.tickets <= 0 || (p.hadHq && !hasHq.has(p.id));
    else lost ||= !hasProduction.has(p.id);
    if (lost) defeat(world, p.id);
    p.tickets = Math.max(0, team.tickets);
  }

  const alive = new Set<TeamId>();
  for (const p of world.players.values()) if (!p.defeated) alive.add(p.team);
  for (const t of world.teams.values()) t.defeated = !alive.has(t.id);
  if (world.teams.size >= 2 && alive.size <= 1) {
    world.over = true;
    world.winner = alive.size === 1 ? [...alive][0] : -1;
    world.emit({ type: 'victory', team: world.winner, tick: world.tick });
  }
}

/** Marks a player defeated and destroys everything they own; their points go neutral. */
export function defeat(world: World, player: PlayerId): void {
  const p = world.players.get(player);
  if (!p || p.defeated) return;
  p.defeated = true;
  world.emit({ type: 'defeated', player });
  for (const e of world.entities.values()) {
    if (e.owner !== player) continue;
    if (e.kind === 'point') {
      e.owner = NEUTRAL;
      e.team = -1;
      e.captureProgress = 0;
      e.capturer = NEUTRAL;
      e.hp = 0;
      e.stock = 0;
      e.truck = 0;
    } else if (!e.dead) {
      e.dead = true;
      e.hp = 0;
    }
  }
}
