// What one AI player knows: its own forces, the map, and only the enemies its fog of war shows it.
// Enemy structures are remembered where they were last seen (until a look shows they're gone);
// enemy unit types seen recently drive counter-production.

import unitsJson from '../../data/units.json';
import structuresJson from '../../data/structures.json';
import type { MapDef } from '../shared/data';
import type { EntityState, SimView, SimViewExt } from '../shared/entities';
import type { EntityId, PlayerId, TeamId, Vec2 } from '../shared/types';

export interface AiUnitDef {
  name: string;
  domain: 'ground' | 'air' | 'naval';
  armor: 'infantry' | 'light' | 'heavy' | 'air' | 'naval' | 'structure';
  hp: number;
  speed: number;
  cost: number;
  cp: number;
  tier: number;
  weapons: string[];
  squad?: number;
  builder?: boolean;
  abilities?: string[];
  logistics?: boolean;
  transport?: { seats: number; carries: string[] };
}

export interface AiStructureDef {
  name: string;
  cost: number;
  power: number;
  tier: number;
  footprint: [number, number];
  requires?: string[];
  produces?: string[];
  placement?: string;
  garrison?: number;
  superweapon?: boolean;
  production?: boolean;
  buildable?: boolean;
}

export const UNIT_DEFS = unitsJson as unknown as Record<string, AiUnitDef>;
export const STRUCTURE_DEFS = structuresJson as unknown as Record<string, AiStructureDef>;

/** Coarse roles the AI reasons about (counter table keys). */
export type Role = 'infantry' | 'antitank' | 'light' | 'heavy' | 'artillery' | 'aa' | 'air' | 'naval' | 'transport' | 'support';

export function roleOf(type: string): Role {
  const d = UNIT_DEFS[type];
  if (!d) return 'support';
  if (d.logistics || d.builder) return 'support';
  if (d.transport && (d.domain !== 'ground' || type === 'transport_ship')) return 'transport';
  if (d.domain === 'air') return 'air';
  if (d.domain === 'naval') return 'naval';
  if (type === 'artillery' || type === 'rocket_truck') return 'artillery';
  if (type === 'aa_tank') return 'aa';
  if (type === 'at_soldier') return 'antitank';
  if (d.armor === 'infantry') return 'infantry';
  return d.armor === 'heavy' ? 'heavy' : 'light';
}

/** Supply value of one entity. */
export function valueOf(type: string): number {
  const u = UNIT_DEFS[type];
  if (u) return Math.max(30, u.cost / (u.squad ?? 1));
  const s = STRUCTURE_DEFS[type];
  return s ? Math.max(100, s.cost) : 0;
}

export interface Seen {
  id: EntityId;
  type: string;
  owner: PlayerId;
  pos: Vec2;
  /** Game seconds when last seen. */
  at: number;
}

export class Knowledge {
  readonly team: TeamId;
  /** Enemy structures by id, as last seen. */
  readonly structures = new Map<EntityId, Seen>();
  /** Enemy units currently visible. */
  visible: EntityState[] = [];
  /** Recently seen enemy units (by id) for composition. */
  private readonly units = new Map<EntityId, Seen>();
  own: EntityState[] = [];
  points: EntityState[] = [];
  now = 0;

  constructor(
    readonly player: PlayerId,
    private readonly sim: SimView & SimViewExt,
    readonly map: MapDef,
    private readonly teamOf: (p: PlayerId) => TeamId,
  ) {
    this.team = teamOf(player);
  }

  isEnemy(owner: PlayerId): boolean {
    return owner >= 0 && this.teamOf(owner) !== this.team;
  }

  isFriend(owner: PlayerId): boolean {
    return owner >= 0 && this.teamOf(owner) === this.team;
  }

  /** Refresh from the sim (only what the fog shows). */
  refresh(now: number): void {
    this.now = now;
    const fog = this.sim.fog;
    this.own = [];
    this.points = [];
    this.visible = [];
    for (const e of this.sim.entities()) {
      if (e.kind === 'point') {
        this.points.push(e);
        continue;
      }
      if (e.owner === this.player) {
        this.own.push(e);
        continue;
      }
      if (!this.isEnemy(e.owner) || !fog.canSee(this.player, e.id)) continue;
      if (e.kind === 'structure') this.structures.set(e.id, { id: e.id, type: e.type, owner: e.owner, pos: { x: e.pos.x, z: e.pos.z }, at: now });
      else if (e.kind === 'unit' && !UNIT_DEFS[e.type]?.logistics) {
        this.visible.push(e);
        this.units.set(e.id, { id: e.id, type: e.type, owner: e.owner, pos: { x: e.pos.x, z: e.pos.z }, at: now });
      } else if (e.kind === 'unit') this.visible.push(e);
    }
    // Forget structures we can see are gone, and old unit sightings.
    for (const [id, s] of this.structures) {
      if (s.at === now) continue;
      if (fog.isVisible(this.player, s.pos.x, s.pos.z) && !this.sim.get(id)) this.structures.delete(id);
    }
    for (const [id, s] of this.units) if (now - s.at > 240 || (s.at !== now && !this.sim.get(id))) this.units.delete(id);
  }

  /** Share of each role among enemy units seen recently (0..1), plus the total value seen. */
  enemyMix(): { mix: Record<Role, number>; total: number } {
    const mix: Record<Role, number> = { infantry: 0, antitank: 0, light: 0, heavy: 0, artillery: 0, aa: 0, air: 0, naval: 0, transport: 0, support: 0 };
    let total = 0;
    for (const s of this.units.values()) {
      const v = valueOf(s.type);
      mix[roleOf(s.type)] += v;
      total += v;
    }
    if (total > 0) for (const k of Object.keys(mix) as Role[]) mix[k] /= total;
    return { mix, total };
  }

  /** Visible enemy strength (value, hp-weighted) within `r` of `p`. */
  enemyStrength(p: Vec2, r: number): number {
    let s = 0;
    for (const e of this.visible) {
      const dx = e.pos.x - p.x;
      const dz = e.pos.z - p.z;
      if (dx * dx + dz * dz <= r * r) s += (valueOf(e.type) * e.hp) / Math.max(1, e.maxHp);
    }
    for (const st of this.structures.values()) {
      if (!STRUCTURE_DEFS[st.type] || (st.type !== 'watchtower' && st.type !== 'trench' && st.type !== 'ruin')) continue;
      const dx = st.pos.x - p.x;
      const dz = st.pos.z - p.z;
      if (dx * dx + dz * dz <= r * r) s += 250;
    }
    return s;
  }

  /** Remembered enemy units near a point recently (they may still be there). */
  recentEnemyStrength(p: Vec2, r: number, maxAge = 45): number {
    let s = 0;
    for (const u of this.units.values()) {
      if (this.now - u.at > maxAge) continue;
      const dx = u.pos.x - p.x;
      const dz = u.pos.z - p.z;
      if (dx * dx + dz * dz <= r * r) s += valueOf(u.type);
    }
    return s;
  }

  ownByType(type: string): EntityState[] {
    return this.own.filter((e) => e.type === type);
  }

  /** Remembered enemy structures. */
  enemyStructures(): Seen[] {
    return [...this.structures.values()];
  }
}
