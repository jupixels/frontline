import abilitiesJson from '../../data/abilities.json';
import type { UnitDef } from '../shared/data';
import type { EntityState, FrontlineView, PauseView, PlayerState, SimView, SimViewExt, SuperweaponView } from '../shared/entities';
import type { EntityId, MatchSetup, PlayerId, PlayerSlot, TeamId, Vec2 } from '../shared/types';

/** What the HUD shows for an ability (data/abilities.json). */
export interface AbilityInfo {
  name: string;
  target: 'self' | 'point' | 'unit';
  cooldown: number;
  cost: number;
}
const ABILITIES = abilitiesJson as Record<string, AbilityInfo>;

/**
 * Everything the HUD reads beyond `SimView` (structures, production queues, power, command
 * points, capture progress, fog). Uses `SimViewExt` when the sim implements it (the real
 * Simulation does) and falls back to placeholders otherwise (tests, stand-alone UI work).
 */

export interface StructureInfo {
  id: string;
  name: string;
  cost: number;
  buildSeconds: number;
  /** Footprint radius in meters (used for the placement ghost and overlap checks). */
  footprint: number;
  /** Positive produces power, negative consumes. */
  power: number;
  /** Unit types this structure trains. */
  produces: string[];
  hotkeyHint?: string;
  /** Infantry seats for garrisoning. */
  garrison?: number;
  /** Fires the superweapon. */
  superweapon?: boolean;
}

// TODO(sim): replace with data/structures.json once it exists (shape proposed in the PR).
export const FALLBACK_STRUCTURES: Record<string, StructureInfo> = {
  hq: { id: 'hq', name: 'Headquarters', cost: 0, buildSeconds: 0, footprint: 12, power: 10, produces: ['engineer'] },
  barracks: { id: 'barracks', name: 'Barracks', cost: 300, buildSeconds: 25, footprint: 9, power: -5, produces: ['rifleman', 'antitank', 'sniper'] },
  war_factory: { id: 'war_factory', name: 'War Factory', cost: 800, buildSeconds: 45, footprint: 14, power: -15, produces: ['jeep', 'ifv', 'tank_mbt'] },
  supply_depot: { id: 'supply_depot', name: 'Supply Depot', cost: 250, buildSeconds: 20, footprint: 8, power: -2, produces: [] },
  power_plant: { id: 'power_plant', name: 'Power Plant', cost: 350, buildSeconds: 25, footprint: 10, power: 30, produces: [] },
  radar: { id: 'radar', name: 'Radar Station', cost: 600, buildSeconds: 35, footprint: 7, power: -10, produces: [] },
  helipad: { id: 'helipad', name: 'Helipad', cost: 900, buildSeconds: 40, footprint: 11, power: -15, produces: ['attack_heli', 'utility_heli'] },
  watchtower: { id: 'watchtower', name: 'Watchtower', cost: 150, buildSeconds: 12, footprint: 4, power: 0, produces: [] },
};

// TODO(sim): builders should be declared in data (e.g. `builds: string[]` on the unit def).
// Until an engineer exists, the recon jeep stands in so the build flow can be exercised.
const FALLBACK_BUILDERS: Record<string, string[]> = {
  engineer: ['barracks', 'war_factory', 'supply_depot', 'power_plant', 'radar', 'helipad', 'watchtower'],
  engineer_truck: ['barracks', 'war_factory', 'supply_depot', 'power_plant', 'radar', 'helipad', 'watchtower'],
  jeep: ['barracks', 'war_factory', 'supply_depot', 'power_plant', 'radar', 'watchtower'],
};

export interface QueueItem {
  unit: string;
  /** 0..1 for the item in production, 0 for waiting items. */
  progress: number;
}

export interface EconomyView {
  supply: number;
  /** Power produced and consumed. `null` when the sim doesn't track it yet. */
  power: { produced: number; used: number } | null;
  /** Single power number from PlayerState (net) when the breakdown is missing. */
  netPower: number;
  commandPoints: { used: number; cap: number };
  morale: number;
  /** Tech tier 1..3. */
  tier: number;
  pointsHeld: number;
}

export interface TeamMorale {
  team: TeamId;
  morale: number;
  /** Starting morale, for the bar. */
  max: number;
  color: string;
  players: PlayerSlot[];
  defeated: boolean;
}

export interface CapturePoint {
  id: number;
  pos: Vec2;
  owner: PlayerId;
  /** -1..1 capture progress toward `capturer`, if the sim exposes it. */
  progress?: number;
  capturer?: PlayerId;
  name?: string;
}

type Loose = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Starting morale per side (GAME_PLAN §4). TODO(sim): read from the match rules. */
export const START_MORALE = 1000;
/** TODO(sim): command point cap comes from held points. */
const FALLBACK_CP_CAP = 100;
/** TODO(sim): per-unit CP cost should live in data/units.json. */
function cpCost(def: UnitDef | undefined): number {
  if (!def) return 1;
  if (def.armor === 'infantry') return 1;
  if (def.armor === 'heavy') return 4;
  return 2;
}

export class SimAdapter {
  private readonly slots = new Map<PlayerId, PlayerSlot>();
  /** The sim's extended read API, when present. */
  private readonly ext: SimViewExt | null;

  constructor(
    private readonly sim: SimView,
    readonly setup: MatchSetup,
    readonly units: Record<string, UnitDef>,
    readonly structures: Record<string, StructureInfo> = FALLBACK_STRUCTURES,
  ) {
    for (const p of setup.players) this.slots.set(p.id, p);
    this.ext = typeof (sim as Partial<SimViewExt>).economy === 'function' ? (sim as SimView & SimViewExt) : null;
  }

  slot(id: PlayerId): PlayerSlot | undefined {
    return this.slots.get(id);
  }

  colorOf(owner: PlayerId): string {
    return this.slots.get(owner)?.color ?? '#9aa39a';
  }

  teamOf(owner: PlayerId): TeamId | undefined {
    return this.slots.get(owner)?.team;
  }

  isAlly(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    const ta = this.teamOf(a);
    return ta !== undefined && ta === this.teamOf(b);
  }

  displayName(type: string): string {
    return this.units[type]?.name ?? this.structures[type]?.name ?? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  isStructure(e: EntityState): boolean {
    return e.kind === 'structure';
  }

  /** Fog of war: whether `viewer` can currently see `e`. */
  isVisible(e: EntityState, viewer: PlayerId): boolean {
    return this.ext ? this.ext.fog.canSee(viewer, e.id) : true;
  }

  economy(player: PlayerId): EconomyView {
    const x = this.ext?.economy(player);
    if (x) {
      return {
        supply: x.supply,
        power: { produced: x.powerProduced, used: x.powerUsed },
        netPower: x.power,
        commandPoints: { used: x.cp, cap: x.cpCap },
        morale: x.morale,
        tier: x.tier,
        pointsHeld: x.pointsHeld,
      };
    }
    const p = this.sim.player(player) as (PlayerState & Loose) | undefined;
    let used = 0;
    for (const e of this.sim.entities()) if (e.owner === player && e.kind === 'unit') used += cpCost(this.units[e.type]);
    // TODO(sim): `powerProduced`/`powerUsed`, `commandPoints`/`commandPointCap` on PlayerState.
    const produced = num(p?.powerProduced);
    const consumed = num(p?.powerUsed);
    return {
      supply: p?.supply ?? 0,
      power: produced !== undefined && consumed !== undefined ? { produced, used: consumed } : null,
      netPower: p?.power ?? 0,
      commandPoints: { used: num(p?.commandPoints) ?? used, cap: num(p?.commandPointCap) ?? FALLBACK_CP_CAP },
      morale: p?.morale ?? 0,
      tier: 1,
      pointsHeld: 0,
    };
  }

  /**
   * Whose army `player` plays: their own, or a teammate's in shared-command co-op. The HUD shows
   * that army's economy, base and production.
   */
  armyOf(player: PlayerId): PlayerId {
    const slot = this.slots.get(player);
    const army = slot?.army !== undefined ? this.slots.get(slot.army) : undefined;
    return army && army.team === slot!.team && army.army === undefined ? army.id : player;
  }

  /** Teammates sharing `player`'s army (co-op), the army owner included, `player` excluded. */
  coCommanders(player: PlayerId): PlayerSlot[] {
    const army = this.armyOf(player);
    return this.setup.players.filter((p) => p.id !== player && this.armyOf(p.id) === army);
  }

  /** Whether `player` may order `e` (owner, shared command, co-op role). */
  canOrder(player: PlayerId, e: EntityState): boolean {
    if (this.ext) return this.ext.canCommand(player, e.id);
    return e.owner === player;
  }

  /** Whether `e` belongs to `player`'s army (orderable or not: co-op roles may limit orders). */
  inArmy(player: PlayerId, e: EntityState): boolean {
    return e.owner === player || e.owner === this.armyOf(player);
  }

  /** Every unit a structure type can ever train (locked ones included), from data. */
  allProduces(type: string): string[] {
    return this.structures[type]?.produces ?? [];
  }

  /** Structure types `owner` has finished. */
  ownedStructures(owner: PlayerId): Set<string> {
    const out = new Set<string>();
    for (const e of this.sim.entities()) if (e.owner === owner && e.kind === 'structure' && this.buildProgress(e) === undefined) out.add(e.type);
    return out;
  }

  /**
   * Morale per team. PlayerState carries morale per player; when the sim keeps one pool per
   * team every member mirrors it, so the max is the team's value either way.
   */
  teamMorale(): TeamMorale[] {
    const teams = new Map<TeamId, TeamMorale>();
    for (const slot of this.setup.players) {
      const ps = this.sim.player(slot.id);
      let t = teams.get(slot.team);
      if (!t) {
        t = { team: slot.team, morale: 0, max: START_MORALE, color: slot.color, players: [], defeated: true };
        teams.set(slot.team, t);
      }
      t.players.push(slot);
      t.morale = Math.max(t.morale, ps?.morale ?? 0);
      t.max = Math.max(t.max, ps?.morale ?? 0);
      t.defeated = t.defeated && (ps?.defeated ?? false);
    }
    return [...teams.values()].sort((a, b) => a.team - b.team);
  }

  /** Capture points. TODO(sim): `captureProgress`/`capturer`/`name` fields on point entities. */
  points(): CapturePoint[] {
    const out: CapturePoint[] = [];
    for (const e of this.sim.entities()) {
      if (e.kind !== 'point') continue;
      const l = e as EntityState & Loose;
      const c = this.ext?.capture(e.id);
      out.push({
        id: e.id,
        pos: e.pos,
        owner: e.owner,
        progress: c ? c.progress : num(l.captureProgress),
        capturer: c ? c.capturer : num(l.capturer),
        name: typeof l.name === 'string' ? l.name : undefined,
      });
    }
    return out;
  }

  buildOptions(e: EntityState): StructureInfo[] {
    const l = e as EntityState & Loose;
    const fromSim = Array.isArray(l.builds) ? (l.builds as unknown[]).filter((s): s is string => typeof s === 'string') : null;
    const isBuilder = (this.units[e.type] as (UnitDef & { builder?: boolean }) | undefined)?.builder;
    const ids = fromSim ?? (this.ext && isBuilder ? this.ext.buildable(e.owner) : null) ?? FALLBACK_BUILDERS[e.type] ?? [];
    return ids.map((id) => this.structures[id]).filter((s): s is StructureInfo => !!s);
  }

  isBuilder(e: EntityState): boolean {
    return e.kind === 'unit' && this.buildOptions(e).length > 0;
  }

  /** Unit types a structure can train. */
  producible(e: EntityState): string[] {
    if (e.kind !== 'structure') return [];
    const l = e as EntityState & Loose;
    if (Array.isArray(l.produces)) return (l.produces as unknown[]).filter((s): s is string => typeof s === 'string');
    return this.structures[e.type]?.produces ?? [];
  }

  /** TODO(sim): production queue on structures, e.g. `queue: { unit: string; progress: number }[]`. */
  queue(e: EntityState): QueueItem[] {
    if (this.ext) return this.ext.queue(e.id).map((q) => ({ unit: q.unit, progress: q.progress }));
    const raw = (e as EntityState & Loose).queue ?? (e as EntityState & Loose).production;
    if (!Array.isArray(raw)) return [];
    const out: QueueItem[] = [];
    for (const it of raw as Loose[]) {
      if (it && typeof it.unit === 'string') out.push({ unit: it.unit, progress: num(it.progress) ?? 0 });
    }
    return out;
  }

  /** TODO(sim): `rally` on structures. */
  rally(e: EntityState): Vec2 | null {
    if (this.ext) return this.ext.rally(e.id);
    const r = (e as EntityState & Loose).rally as Vec2 | undefined;
    return r && typeof r.x === 'number' && typeof r.z === 'number' ? r : null;
  }

  /** Construction progress 0..1 for structures being built, else undefined. TODO(sim). */
  buildProgress(e: EntityState): number | undefined {
    if (this.ext && e.kind === 'structure') {
      const p = this.ext.buildProgress(e.id);
      return p < 1 ? p : undefined;
    }
    return num((e as EntityState & Loose).buildProgress);
  }

  costOf(type: string): number {
    return this.units[type]?.cost ?? this.structures[type]?.cost ?? 0;
  }

  /** Abilities of a unit with cooldown (0 = ready) and active state. */
  abilities(e: EntityState): { ability: string; cooldown: number; active: boolean; info: AbilityInfo }[] {
    if (!this.ext) return [];
    return this.ext.abilities(e.id).flatMap((a) => (ABILITIES[a.ability] ? [{ ...a, info: ABILITIES[a.ability] }] : []));
  }

  /** 0.5..1 fire rate and accuracy factor from distance to friendly supply (1 = fully supplied). */
  readiness(e: EntityState): number {
    return this.ext && e.kind === 'unit' ? this.ext.readiness(e.id) : 1;
  }

  unitDef(type: string): UnitDef | undefined {
    return this.units[type];
  }

  abilityInfo(id: string): AbilityInfo | undefined {
    return ABILITIES[id];
  }

  /** Seats a transport or garrisonable building offers (0 if it carries nobody). */
  capacity(e: EntityState): number {
    if (e.kind === 'structure') return this.structures[e.type]?.garrison ?? 0;
    return (this.units[e.type] as (UnitDef & { transport?: { seats: number } }) | undefined)?.transport?.seats ?? 0;
  }

  /** Whether any of `units` can board/garrison `target`. */
  canEnter(units: EntityId[], target: EntityState): boolean {
    if (!this.ext || this.capacity(target) <= 0) return false;
    return units.some((u) => this.ext!.canEnter(u, target.id));
  }

  superweapon(player: PlayerId): SuperweaponView | null {
    return this.ext?.superweapon(player) ?? null;
  }

  lines(player: PlayerId): readonly FrontlineView[] {
    return this.ext?.lines(player) ?? [];
  }

  pause(): PauseView | null {
    return this.ext?.pause ?? null;
  }

  /** Overlap check for structure placement: the sim's rules when available, else bounds + footprints. */
  canPlace(structure: string, at: Vec2, mapSize: number, player?: PlayerId, rotation = 0): boolean {
    const s = this.structures[structure];
    if (!s) return false;
    if (this.ext && player !== undefined) return this.ext.canPlace(player, structure, at, rotation);
    const half = mapSize / 2 - s.footprint;
    if (Math.abs(at.x) > half || Math.abs(at.z) > half) return false;
    for (const e of this.sim.entities()) {
      // Units step aside for construction; structures and capture points block.
      if (e.kind !== 'structure' && e.kind !== 'point') continue;
      const r = e.kind === 'structure' ? (this.structures[e.type]?.footprint ?? 8) : 10;
      const dx = e.pos.x - at.x;
      const dz = e.pos.z - at.z;
      const min = r + s.footprint;
      if (dx * dx + dz * dz < min * min) return false;
    }
    return true;
  }
}
