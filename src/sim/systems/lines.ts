// Drawn frontlines (holdLine). Units spread along a polyline by role, facing away from their own side:
// infantry on the line (into woods or trenches when there are some), anti-tank teams on the flanks,
// tanks a little behind, AA further back, artillery well behind. Spacing follows the threat in front,
// so gaps close when units die and reinforcements go where the line is weakest.

import { TICK_SECONDS, type PlayerId, type Vec2 } from '../../shared/types';
import { dcos, dsin, headingTo, turnToward } from '../math/dmath';
import { FLAG_FOREST } from '../path/navgrid';
import type { Entity, Frontline, World } from '../world';
import { packUp } from './abilities';
import { board, canEnter } from './containers';
import { followPath, setPath } from './movement';
import { valueOf } from './veterancy';

const UPDATE_TICKS = 10;
const BUCKETS = 12;
/** How far in front of the line enemies count as pressure on it. */
const THREAT_RANGE = 160;
const MAX_POINTS = 32;
/** Infantry look this far from their slot for woods or a trench. */
const COVER_SEARCH = 14;
/** Longest single advance order, meters. */
const MAX_ADVANCE = 600;
/** A marching line moves at this share of its slowest member's top speed (slopes and woods eat the rest). */
const MARCH_PACE = 0.85;
/** The march pauses while a member is more than this far behind its slot... */
const LAG_WAIT = 9;
/** ...unless it's so far behind (stuck, rerouting) that waiting would stall the whole line. */
const LAG_GIVE_UP = 60;
const CONTACT_TICKS = 4;
/** Depth between ranks when a line is too short for everyone. */
const RANK_DEPTH = 7;

/** Room each unit needs along a line, by footprint: infantry spread out, vehicles get wide gaps. */
function spacingOf(u: Entity): number {
  return u.armor === 'infantry' ? 3.2 : Math.max(7, u.radius * 3);
}

type Role = 'inf' | 'at' | 'heavy' | 'light' | 'aa' | 'artillery' | 'air';

/** Meters behind the line per role. */
const BACK: Record<Role, number> = { inf: 0, at: 0, heavy: 10, light: 5, aa: 26, artillery: 75, air: 22 };

function roleOf(e: Entity): Role {
  if (e.domain === 'air') return 'air';
  const ws = e.weapons.map((w) => w.def);
  if (ws.some((w) => w.delivery === 'indirect')) return 'artillery';
  if (ws.length && ws.every((w) => w.targets.length === 1 && w.targets[0] === 'air')) return 'aa';
  if (e.armor === 'infantry') return ws.some((w) => w.damageType === 'ap') ? 'at' : 'inf';
  return e.armor === 'heavy' ? 'heavy' : 'light';
}

function cleanPoints(world: World, points: Vec2[]): Vec2[] {
  const half = world.map.size / 2 - 2;
  const out: Vec2[] = [];
  for (const p of points.slice(0, 256)) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const q = { x: Math.max(-half, Math.min(half, p.x)), z: Math.max(-half, Math.min(half, p.z)) };
    const last = out[out.length - 1];
    if (last && (last.x - q.x) * (last.x - q.x) + (last.z - q.z) * (last.z - q.z) < 16) continue;
    out.push(q);
  }
  // Too many points: keep every k-th (and the last).
  if (out.length > MAX_POINTS) {
    const k = Math.ceil(out.length / MAX_POINTS);
    const thin = out.filter((_, i) => i % k === 0);
    if (thin[thin.length - 1] !== out[out.length - 1]) thin.push(out[out.length - 1]);
    return thin;
  }
  return out;
}

function lengthOf(points: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    L += Math.sqrt(dx * dx + dz * dz);
  }
  return L;
}

/** Point at fraction `t` (0..1) of the polyline's length. */
function pointAt(points: Vec2[], t: number): Vec2 {
  const L = lengthOf(points);
  let want = Math.max(0, Math.min(1, t)) * L;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    const seg = Math.sqrt(dx * dx + dz * dz);
    if (want <= seg || i === points.length - 1) {
      const f = seg > 0 ? Math.min(1, want / seg) : 0;
      return { x: points[i - 1].x + dx * f, z: points[i - 1].z + dz * f };
    }
    want -= seg;
  }
  return { x: points[0].x, z: points[0].z };
}

/** Fraction along the polyline of the point nearest `p`. */
function projectT(points: Vec2[], p: Vec2): number {
  const L = lengthOf(points);
  if (L <= 0) return 0;
  let acc = 0;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const seg = Math.sqrt(len2);
    let f = len2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const qx = a.x + dx * f - p.x;
    const qz = a.z + dz * f - p.z;
    const d = qx * qx + qz * qz;
    if (d < bestD) {
      bestD = d;
      bestT = (acc + seg * f) / L;
    }
    acc += seg;
  }
  return bestT;
}

/** Facing of a line: perpendicular to its overall direction, away from the owner's HQ (or `back`). */
function facingFor(world: World, owner: PlayerId, points: Vec2[], back: Vec2): number {
  const a = points[0];
  const b = points[points.length - 1];
  let nx = -(b.z - a.z);
  let nz = b.x - a.x;
  let home = back;
  for (const e of world.entities.values()) {
    if (e.kind === 'structure' && e.type === 'hq' && e.owner === owner && !e.dead) {
      home = e.pos;
      break;
    }
  }
  const mid = pointAt(points, 0.5);
  if ((home.x - mid.x) * nx + (home.z - mid.z) * nz > 0) {
    nx = -nx;
    nz = -nz;
  }
  return headingTo(nx, nz);
}

/** Take a unit off its line (it got another order, boarded something, or died). */
export function leaveLine(world: World, e: Entity): void {
  const line = world.lines.get(e.line);
  if (line) {
    const i = line.units.indexOf(e.id);
    if (i >= 0) line.units.splice(i, 1);
    line.dirty = true;
  }
  e.line = 0;
  e.lineSlot = null;
  if (e.order?.kind === 'line') e.order = null;
}

/** `holdLine` command. With `lineId`, the units reinforce that line. Returns the line, or null. */
export function orderHoldLine(world: World, player: PlayerId, units: Entity[], points: Vec2[], lineId: number | undefined): Frontline | null {
  if (!units.length) return null;
  let line = lineId !== undefined ? world.lines.get(lineId) : undefined;
  if (line && line.team !== world.teamOf(player)) line = undefined;
  let change: 'formed' | 'reinforced' = 'reinforced';
  if (!line) {
    const pts = cleanPoints(world, Array.isArray(points) ? points : []);
    if (pts.length < 2 || lengthOf(pts) < 8) return null;
    let cx = 0;
    let cz = 0;
    for (const u of units) {
      cx += u.pos.x / units.length;
      cz += u.pos.z / units.length;
    }
    const owner = units[0].owner;
    line = { id: world.nextLineId++, owner, team: world.teamOf(owner), points: pts, facing: facingFor(world, owner, pts, { x: cx, z: cz }), units: [], strength: [], dirty: true, march: null, target: null };
    world.lines.set(line.id, line);
    change = 'formed';
  }
  for (const u of units) {
    if (u.line === line.id) continue;
    if (u.line) leaveLine(world, u);
    packUp(u);
    u.order = { kind: 'line', lineId: line.id };
    u.orderQueue.length = 0;
    u.path = null;
    u.target = 0;
    u.guard = null;
    u.line = line.id;
    u.lineSlot = null;
    line.units.push(u.id);
  }
  line.dirty = true;
  world.emit({ type: 'line', line: line.id, owner: line.owner, change });
  return line;
}

/**
 * Advance (or pull back, negative) a whole line by `distance` meters along its facing. The line
 * marches: it moves at the pace of its slowest member, waits for stragglers, keeps its spacing,
 * and halts where it makes contact. Another advance during a march extends it.
 */
export function advanceLine(world: World, player: PlayerId, lineId: number, distance: number): void {
  const line = world.lines.get(lineId);
  if (!line || line.team !== world.teamOf(player) || !Number.isFinite(distance)) return;
  const fx = dsin(line.facing);
  const fz = dcos(line.facing);
  // Carry on from a march in progress (signed along the facing).
  const prior = line.march ? line.march.left * (line.march.dx * fx + line.march.dz * fz >= 0 ? 1 : -1) : 0;
  const d = Math.max(-MAX_ADVANCE, Math.min(MAX_ADVANCE, prior + distance));
  if (d * d < 1) {
    line.march = null;
    line.target = null;
    return;
  }
  const sign = d > 0 ? 1 : -1;
  let speed = Infinity;
  for (const id of line.units) {
    const u = world.entities.get(id);
    if (u?.unit && u.domain !== 'air' && u.unit.speed < speed) speed = u.unit.speed;
  }
  if (speed === Infinity) speed = 10;
  line.march = { dx: fx * sign, dz: fz * sign, left: sign * d, speed: speed * MARCH_PACE };
  line.target = shifted(world, line.points, line.march.dx * line.march.left, line.march.dz * line.march.left);
  // Units in trenches climb out to move up with the line.
  for (const id of line.units) {
    const u = world.entities.get(id);
    if (u?.inside) {
      const c = world.entities.get(u.inside);
      if (c) {
        c.cargo = c.cargo.filter((x) => x !== u.id);
        u.inside = 0;
        world.emit({ type: 'boarded', id: u.id, container: c.id, entered: false });
      }
    }
  }
  world.emit({ type: 'line', line: line.id, owner: line.owner, change: 'advanced' });
}

/** The polyline moved by (dx, dz), kept inside the map. */
function shifted(world: World, points: Vec2[], dx: number, dz: number): Vec2[] {
  const half = world.map.size / 2 - 2;
  return points.map((p) => ({ x: Math.max(-half, Math.min(half, p.x + dx)), z: Math.max(-half, Math.min(half, p.z + dz)) }));
}

/**
 * One tick of a marching line: if nobody is lagging, slide the line (and every slot) forward at the
 * line's pace; stop at the end, or as soon as an enemy is visible within weapon range of a member.
 */
function marchTick(world: World, line: Frontline, members: Entity[]): void {
  const m = line.march!;
  // Contact: halt and fight where we stand (checked every few ticks, staggered by line id).
  if ((world.tick + line.id) % CONTACT_TICKS === 0) {
    for (const u of members) {
      let range = 0;
      for (const w of u.weapons) if (w.def.range > range && w.def.delivery !== 'indirect') range = w.def.range;
      if (range <= 0 || u.inside) continue;
      let contact = false;
      world.spatial.query(u.pos.x, u.pos.z, range, (o) => {
        // Any enemy in reach counts, buildings too: the line stops and shoots rather than walk past.
        if (o.dead || o.kind === 'point' || !world.areEnemies(line.team, o.team) || o.inside) return;
        if (!world.fog.teamVisible(line.team, o.pos.x, o.pos.z)) return;
        contact = true;
        return true;
      });
      if (contact) {
        line.march = null;
        line.target = null;
        line.dirty = true;
        return;
      }
    }
  }
  // Wait for stragglers so the line arrives together (units hopelessly far behind don't hold it up).
  for (const u of members) {
    if (!u.lineSlot || u.domain === 'air' || u.inside) continue;
    const dx = u.lineSlot.x - u.pos.x;
    const dz = u.lineSlot.z - u.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > LAG_WAIT * LAG_WAIT && d2 < LAG_GIVE_UP * LAG_GIVE_UP) return;
  }
  const step = Math.min(m.left, m.speed * TICK_SECONDS);
  const sx = m.dx * step;
  const sz = m.dz * step;
  line.points = shifted(world, line.points, sx, sz);
  for (const u of members) {
    if (!u.lineSlot) continue;
    u.lineSlot = { x: u.lineSlot.x + sx, z: u.lineSlot.z + sz };
  }
  m.left -= step;
  if (m.left <= 1e-6) {
    line.march = null;
    line.target = null;
    line.dirty = true;
  }
}

export function disbandLine(world: World, player: PlayerId, lineId: number): void {
  const line = world.lines.get(lineId);
  if (!line || line.team !== world.teamOf(player)) return;
  removeLine(world, line);
}

function removeLine(world: World, line: Frontline): void {
  for (const id of line.units) {
    const u = world.entities.get(id);
    if (!u) continue;
    u.line = 0;
    u.lineSlot = null;
    if (u.order?.kind === 'line') u.order = null;
    u.guard = { x: u.pos.x, z: u.pos.z };
  }
  world.lines.delete(line.id);
  world.emit({ type: 'line', line: line.id, owner: line.owner, change: 'disbanded' });
}

/** Enemy pressure and friendly strength per bucket along the line. */
function pressure(world: World, line: Frontline): { threat: number[]; friendly: number[] } {
  const threat = new Array<number>(BUCKETS).fill(0);
  const friendly = new Array<number>(BUCKETS).fill(0);
  const fx = dsin(line.facing);
  const fz = dcos(line.facing);
  for (let b = 0; b < BUCKETS; b++) {
    const p = pointAt(line.points, (b + 0.5) / BUCKETS);
    world.spatial.query(p.x, p.z, THREAT_RANGE, (o) => {
      if (o.dead || o.kind !== 'unit') return;
      const ahead = (o.pos.x - p.x) * fx + (o.pos.z - p.z) * fz;
      if (o.team === line.team) {
        if (ahead > -90 && ahead < 40) friendly[b] += (valueOf(o) * o.hp) / o.maxHp;
      } else if (world.areEnemies(line.team, o.team) && ahead > -20 && world.fog.teamVisible(line.team, o.pos.x, o.pos.z)) {
        threat[b] += valueOf(o);
      }
    });
  }
  return { threat, friendly };
}

/** Weighted quantiles: `n` positions along 0..1 where density follows `w` per bucket. */
function quantiles(w: number[], n: number): number[] {
  let total = 0;
  for (const x of w) total += x;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const want = ((i + 0.5) / n) * total;
    let acc = 0;
    let t = 1;
    for (let b = 0; b < w.length; b++) {
      if (acc + w[b] >= want) {
        t = (b + (want - acc) / w[b]) / w.length;
        break;
      }
      acc += w[b];
    }
    out.push(t);
  }
  return out;
}

/** Nearby woods or an enterable trench/ruin for an infantry slot. */
function coverNear(world: World, u: Entity, slot: Vec2): { at: Vec2; structure: Entity | null } | null {
  let best: Entity | null = null;
  let bestD = COVER_SEARCH * COVER_SEARCH;
  world.spatial.query(slot.x, slot.z, COVER_SEARCH + 12, (s, d2) => {
    if (s.kind !== 'structure' || s.capacity <= 0 || d2 >= bestD || !canEnter(world, u, s)) return;
    best = s;
    bestD = d2;
  });
  if (best) return { at: (best as Entity).pos, structure: best };
  const nav = world.nav;
  if (nav.flagsAt(slot) & FLAG_FOREST) return null;
  for (let r = 4; r <= COVER_SEARCH; r += 4) {
    for (let k = 0; k < 8; k++) {
      const p = { x: slot.x + dsin(k * 0.785) * r, z: slot.z + dcos(k * 0.785) * r };
      if (nav.inBounds(p) && nav.flagsAt(p) & FLAG_FOREST && nav.passableAt(p, 'ground')) return { at: p, structure: null };
    }
  }
  return null;
}

function assignSlots(world: World, line: Frontline, members: Entity[]): void {
  const { threat, friendly } = pressure(world, line);
  let maxT = 0;
  for (const t of threat) if (t > maxT) maxT = t;
  const weights = threat.map((t) => 1 + (maxT > 0 ? (3 * t) / maxT : 0));
  line.strength = friendly.map((f, b) => (threat[b] > 0 ? f / (f + threat[b]) : 1));

  const along: Entity[] = [];
  const groups: Record<'aa' | 'artillery' | 'air', Entity[]> = { aa: [], artillery: [], air: [] };
  const roles = new Map<Entity, Role>();
  for (const u of members) {
    const r = roleOf(u);
    roles.set(u, r);
    if (r === 'aa' || r === 'artillery' || r === 'air') groups[r].push(u);
    else along.push(u);
  }
  const ts = new Map<Entity, number>();
  if (along.length) {
    const q = quantiles(weights, along.length);
    // Anti-tank teams take the outermost positions (the flanks), the rest keep their order along the line.
    const byEdge = q.map((t, i) => ({ t, i })).sort((a, b) => Math.abs(b.t - 0.5) - Math.abs(a.t - 0.5) || a.i - b.i);
    const at = along.filter((u) => roles.get(u) === 'at').sort((a, b) => a.id - b.id);
    const taken = new Set<number>();
    for (let k = 0; k < at.length && k < byEdge.length; k++) {
      ts.set(at[k], byEdge[k].t);
      taken.add(byEdge[k].i);
    }
    const rest = along.filter((u) => roles.get(u) !== 'at');
    const proj = new Map(rest.map((u) => [u, projectT(line.points, u.pos)]));
    rest.sort((a, b) => proj.get(a)! - proj.get(b)! || a.id - b.id);
    const free = q.filter((_, i) => !taken.has(i));
    rest.forEach((u, k) => ts.set(u, free[k]));
  }
  // Anti-clumping: every unit gets room for its footprint along the line. A line too short for
  // everyone gets extra ranks behind it; within a rank, units are pushed apart to their spacing.
  const rankOf = new Map<Entity, number>();
  const L = lengthOf(line.points);
  if (along.length && L > 0) {
    const order = [...along].sort((a, b) => ts.get(a)! - ts.get(b)! || a.id - b.id);
    let need = 0;
    for (const u of order) need += spacingOf(u);
    const ranks = Math.max(1, Math.ceil(need / L));
    for (let r = 0; r < ranks; r++) {
      const row = order.filter((_, i) => i % ranks === r);
      if (!row.length) continue;
      const sp = row.map(spacingOf);
      const at = row.map((u) => ts.get(u)! * L);
      at[0] = Math.max(at[0], sp[0] / 2);
      for (let i = 1; i < row.length; i++) at[i] = Math.max(at[i], at[i - 1] + (sp[i - 1] + sp[i]) / 2);
      const last = row.length - 1;
      at[last] = Math.min(at[last], L - sp[last] / 2);
      for (let i = last - 1; i >= 0; i--) at[i] = Math.min(at[i], at[i + 1] - (sp[i] + sp[i + 1]) / 2);
      row.forEach((u, i) => {
        ts.set(u, Math.max(0, Math.min(1, at[i] / L)));
        rankOf.set(u, r);
      });
    }
  }
  const spread = (list: Entity[], lo: number, hi: number) => {
    list.sort((a, b) => a.id - b.id);
    list.forEach((u, k) => ts.set(u, lo + ((hi - lo) * (k + 0.5)) / list.length));
  };
  spread(groups.artillery, 0.3, 0.7);
  spread(groups.aa, 0.15, 0.85);
  spread(groups.air, 0.2, 0.8);

  const fx = dsin(line.facing);
  const fz = dcos(line.facing);
  for (const u of members) {
    const role = roles.get(u)!;
    const p = pointAt(line.points, ts.get(u) ?? 0.5);
    const back = BACK[role] + (rankOf.get(u) ?? 0) * RANK_DEPTH;
    let slot = { x: p.x - fx * back, z: p.z - fz * back };
    if ((role === 'inf' || role === 'at') && !u.inside) {
      const cover = coverNear(world, u, slot);
      if (cover) slot = { x: cover.at.x, z: cover.at.z };
    }
    slot = world.nav.snap(slot, u.domain);
    const old = u.lineSlot;
    if (!old || (old.x - slot.x) * (old.x - slot.x) + (old.z - slot.z) * (old.z - slot.z) > 9) {
      u.lineSlot = slot;
      u.path = null;
    }
  }
}

/** Keeps every line's slots current (and drops empty lines). */
export function lineSystem(world: World): void {
  if (!world.lines.size) return;
  for (const line of [...world.lines.values()]) {
    const members: Entity[] = [];
    for (const id of line.units) {
      const u = world.entities.get(id);
      if (u && !u.dead && u.line === line.id) members.push(u);
    }
    if (members.length !== line.units.length) {
      line.units = members.map((u) => u.id);
      line.dirty = true;
    }
    if (!members.length) {
      removeLine(world, line);
      continue;
    }
    // Re-plan slots when membership or shape changes, and now and then while holding (threat shifts).
    if (line.dirty || (!line.march && (world.tick + line.id) % UPDATE_TICKS === 0)) {
      assignSlots(world, line, members);
      line.dirty = false;
    }
    if (line.march) {
      marchTick(world, line, members);
      line.target = line.march ? shifted(world, line.points, line.march.dx * line.march.left, line.march.dz * line.march.left) : null;
    }
  }
}

/** One tick of a unit holding its line slot (movementSystem). */
export function lineTick(world: World, e: Entity): void {
  const slot = e.lineSlot;
  const line = world.lines.get(e.line);
  if (!slot || !line || e.inside) return;
  const dx = slot.x - e.pos.x;
  const dz = slot.z - e.pos.z;
  // On the march the slot keeps moving: follow it closely so the line stays straight.
  const marching = !!line.march;
  if (dx * dx + dz * dz > (marching ? 0.36 : 4)) {
    const g = e.path?.goal;
    if (!g || (g.x - slot.x) * (g.x - slot.x) + (g.z - slot.z) * (g.z - slot.z) > 16) setPath(world, e, slot);
    if (!followPath(world, e, marching ? 0.4 : 1.2)) return;
  }
  e.path = null;
  if (marching) {
    if (e.unit) e.heading = turnToward(e.heading, line.facing, e.unit.turnRate * TICK_SECONDS);
    return;
  }
  // In position: get into the trench/ruin at the slot if there is one, else face the enemy.
  if (e.armor === 'infantry') {
    let shelter: Entity | null = null;
    world.spatial.query(e.pos.x, e.pos.z, 24, (s, d2) => {
      const reach = s.radius + e.radius + 3;
      if (!shelter && s.kind === 'structure' && s.capacity > 0 && d2 <= reach * reach && canEnter(world, e, s)) shelter = s;
    });
    if (shelter) {
      board(world, e, shelter);
      // Boarding clears orders; keep the line membership.
      e.order = { kind: 'line', lineId: line.id };
      e.line = line.id;
      if (!line.units.includes(e.id)) line.units.push(e.id);
      return;
    }
  }
  if (e.unit) e.heading = turnToward(e.heading, line.facing, e.unit.turnRate * TICK_SECONDS);
}
