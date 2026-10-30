import abilitiesJson from '../../data/abilities.json';
import damageJson from '../../data/damage.json';
import structuresJson from '../../data/structures.json';
import unitsJson from '../../data/units.json';
import weaponsJson from '../../data/weapons.json';
import type { ArmorClass, Domain } from '../shared/data';
import type { TipContent } from './tooltip';

// Read-only facts for tooltips and info panels, derived from data/ so they never drift from balance:
// roles, weapons, what a unit is strong and weak against, tier and building requirements.

interface WeaponJson {
  range: number;
  damage: number;
  reload: number;
  damageType: keyof typeof damageJson;
  delivery: string;
  targets: Domain[];
  splash?: number;
  minRange?: number;
}
interface UnitJson {
  name: string;
  domain: Domain;
  armor: ArmorClass;
  hp: number;
  speed: number;
  sight: number;
  cost: number;
  buildSeconds: number;
  cp?: number;
  tier?: number;
  weapons?: string[];
  squad?: number;
  abilities?: string[];
  builder?: boolean;
  transport?: { seats: number; carries: string[] };
}
interface StructureJson {
  name: string;
  hp: number;
  cost: number;
  buildSeconds: number;
  power: number;
  sight: number;
  tier?: number;
  requires?: string[];
  produces?: string[];
  buildable?: boolean;
  garrison?: number;
  grantsTier?: number;
  superweapon?: boolean;
  income?: number;
  placement?: string;
  heal?: { radius: number; perSecond: number };
  weapons?: string[];
}
interface AbilityJson {
  name: string;
  target: 'self' | 'point' | 'unit';
  cooldown: number;
  cost: number;
  duration?: number;
  radius?: number;
  range?: number;
}

export const UNIT_DATA = unitsJson as unknown as Record<string, UnitJson>;
export const STRUCTURE_DATA = structuresJson as unknown as Record<string, StructureJson>;
export const WEAPON_DATA = weaponsJson as unknown as Record<string, WeaponJson>;
export const ABILITY_DATA = abilitiesJson as unknown as Record<string, AbilityJson>;
const DAMAGE = damageJson as Record<string, Record<ArmorClass, number>>;

export const ROLE: Record<string, string> = {
  rifleman: 'Four riflemen. They take and hold points and garrison buildings and trenches.',
  sniper: 'Long-range marksman. Picks off infantry, pins squads and spots for artillery.',
  at_soldier: 'Two-man rocket team. Ambushes armor from cover.',
  engineer: 'Builds your base. Keep engineers away from the front.',
  jeep: 'Fast scout with a machine gun and long sight. Spots for artillery.',
  scout_car: 'Armored car with an autocannon. Hunts light vehicles and infantry.',
  ifv: 'Carries 6 infantry. Its autocannon and ATGM back up the squads it delivers.',
  tank_light: 'Fast tank for flanks and raids. Loses to main battle tanks head-on.',
  tank_mbt: 'Heavy armor and a long gun. The front armor is thick, so flank it.',
  aa_tank: 'Shreds helicopters and jets. Nearly harmless to anything on the ground.',
  rocket_truck: 'Rocket salvos on spotted areas from long range. Fragile up close.',
  artillery: 'Self-propelled howitzer with the longest ground range. Needs spotters.',
  heli_attack: 'Rockets and a chin gun. Kills armor fast, dies to AA.',
  heli_transport: 'Carries 8 infantry over rivers, cliffs and water.',
  jet_fighter: 'Air superiority. Hunts helicopters and bombers.',
  bomber: 'Heavy bomb run that flattens clustered units and structures.',
  patrol_boat: 'Fast and cheap. Screens the coast and harasses other boats.',
  destroyer: 'Hunts submarines and covers the fleet with SAMs.',
  cruiser: 'Capital ship. Heavy guns bombard the shore from far out.',
  submarine: 'Silent hunter of capital ships. Cannot hit aircraft.',
  transport_ship: 'Carries 24 infantry or vehicles for amphibious landings.',
  supply_truck: 'Hauls supply from points and depots to your HQ. Protect the route.',
  hq: 'Your command post. Trains engineers and earns supply. In Frontline, losing it loses the match.',
  barracks: 'Trains infantry.',
  war_factory: 'Builds ground vehicles.',
  airfield: 'Builds fighter jets and bombers.',
  helipad: 'Builds helicopters.',
  naval_yard: 'Builds the fleet. Must be placed on a shore.',
  power_plant: 'Powers your base. Low power halves production and shuts off radar, so guard it.',
  supply_depot: 'Earns supply. Earns double next to an oil or supply node.',
  radar: 'Sees far and unlocks Tier 2 units and buildings.',
  hospital: 'Heals infantry standing nearby.',
  watchtower: 'Machine-gun tower with long sight. Holds 4 infantry.',
  trench: 'Cover for up to 8 infantry: they take far less damage inside.',
  ruin: 'Neutral ruin. Up to 8 infantry can garrison it.',
  strategic_command: 'Unlocks Tier 3 and launches the cruise missile.',
  point: 'Strategic point. Holding more points than the enemy drains their Morale.',
};

export const ABILITY_TEXT: Record<string, string> = {
  smoke: 'Drops a smoke screen that blocks sight and targeting through it.',
  entrench: 'Dig in: takes much less damage but cannot move. Use again to pack up.',
  sprint: 'Move 50% faster for a short time.',
  overdrive: 'Engine overdrive: 35% faster for a few seconds.',
  barrage: 'Saturate a spotted area with shells. Needs vision of the target.',
  ambush: 'Hide until the enemy comes close. The first shot hits harder.',
};

const ARMOR_LABEL: Record<ArmorClass, string> = {
  infantry: 'Infantry',
  light: 'Light vehicles',
  heavy: 'Armor',
  air: 'Aircraft',
  naval: 'Ships',
  structure: 'Structures',
};

const ARMOR_DOMAIN: Record<ArmorClass, Domain | 'any'> = { infantry: 'ground', light: 'ground', heavy: 'ground', air: 'air', naval: 'naval', structure: 'ground' };

const TIER_SOURCE: Record<number, string> = { 2: 'Radar Station', 3: 'Strategic Command' };

/** Best damage multiplier a weapon list deals to an armor class (0 if it can't target it). */
function bestVs(weapons: string[] | undefined, armor: ArmorClass): number {
  let best = 0;
  const domain = ARMOR_DOMAIN[armor];
  for (const id of weapons ?? []) {
    const w = WEAPON_DATA[id];
    if (!w) continue;
    if (domain !== 'any' && !w.targets.includes(domain as Domain)) continue;
    const m = DAMAGE[w.damageType]?.[armor] ?? 0;
    // Raw firepower matters too: a pistol's 1.0 vs infantry isn't a counter.
    const dps = w.damage / Math.max(0.1, w.reload);
    best = Math.max(best, m * Math.min(1.4, 0.55 + dps / 60));
  }
  return best;
}

/** Armor classes a unit or structure is good against, best first. */
export function strongVs(type: string): ArmorClass[] {
  const weapons = UNIT_DATA[type]?.weapons ?? STRUCTURE_DATA[type]?.weapons;
  const all: ArmorClass[] = ['infantry', 'light', 'heavy', 'air', 'naval', 'structure'];
  return all
    .map((a) => [a, bestVs(weapons, a)] as const)
    .filter(([, v]) => v >= 0.75)
    .sort((x, y) => y[1] - x[1])
    .map(([a]) => a);
}

/** Unit types that hit `type`'s armor hardest (its counters), up to `n`. */
export function threatsTo(type: string, n = 3): string[] {
  const armor = UNIT_DATA[type]?.armor ?? (STRUCTURE_DATA[type] ? 'structure' : undefined);
  if (!armor) return [];
  return Object.entries(UNIT_DATA)
    .filter(([id, u]) => id !== type && u.weapons?.length && u.cost > 0)
    .map(([id, u]) => [id, bestVs(u.weapons, armor) / Math.sqrt(u.cost / 300)] as const)
    .filter(([, v]) => v > 0.7)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

export function unitName(type: string): string {
  return UNIT_DATA[type]?.name ?? STRUCTURE_DATA[type]?.name ?? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Max weapon range of a unit or structure, meters. */
export function maxRange(type: string): number {
  const ws = UNIT_DATA[type]?.weapons ?? STRUCTURE_DATA[type]?.weapons ?? [];
  return ws.reduce((m, w) => Math.max(m, WEAPON_DATA[w]?.range ?? 0), 0);
}

/** Why `type` can't be produced/built yet, from its tier and building requirements; null if nothing data-wise blocks it. */
export function requirementText(type: string, tier: number, owned: (structure: string) => boolean): string | null {
  const need = UNIT_DATA[type]?.tier ?? STRUCTURE_DATA[type]?.tier ?? 1;
  const reqs = (STRUCTURE_DATA[type]?.requires ?? []).filter((r) => !owned(r));
  const parts: string[] = [];
  if (need > tier) parts.push(`Tier ${need} (build a ${TIER_SOURCE[need] ?? 'tech building'})`);
  if (reqs.length) parts.push(reqs.map(unitName).join(' and '));
  return parts.length ? `Requires ${parts.join(', ')}` : null;
}

/** Tooltip for training a unit or placing a structure. */
export function productionTip(type: string, opts: { supply: number; hotkey?: string; locked?: string | null; queued?: number; icon?: string }): TipContent {
  const u = UNIT_DATA[type];
  const s = STRUCTURE_DATA[type];
  const cost = u?.cost ?? s?.cost ?? 0;
  const costs: TipContent['costs'] = [{ kind: 'supply', text: `${cost}`, poor: cost > opts.supply }];
  if (u?.cp) costs.push({ kind: 'cp', text: `${u.cp} CP` });
  if (s && s.power) costs.push({ kind: 'power', text: `${s.power > 0 ? '+' : ''}${s.power}` });
  costs.push({ kind: 'time', text: `${u?.buildSeconds ?? s?.buildSeconds ?? 0}s` });
  const rows: NonNullable<TipContent['rows']> = [];
  const strong = strongVs(type);
  if (strong.length) rows.push({ k: 'Strong vs', v: strong.map((a) => ARMOR_LABEL[a]).join(', '), cls: 'good' });
  const threats = threatsTo(type);
  if (u && threats.length) rows.push({ k: 'Weak vs', v: threats.map(unitName).join(', '), cls: 'bad' });
  if (u) rows.push({ k: 'Stats', v: `${u.hp} HP${u.squad ? ` ×${u.squad}` : ''} · ${ARMOR_LABEL[u.armor].replace(/s$/, '')} armor · ${u.speed} m/s · range ${maxRange(type)} m` });
  else if (s) rows.push({ k: 'Stats', v: `${s.hp} HP · sight ${s.sight} m${s.garrison ? ` · holds ${s.garrison}` : ''}` });
  const extra: string[] = [];
  if (u?.transport) extra.push(`Carries ${u.transport.seats} ${u.transport.carries.includes('heavy') ? 'infantry or vehicles' : 'infantry'}.`);
  if (u?.abilities?.length) extra.push(`Abilities: ${u.abilities.map((a) => ABILITY_DATA[a]?.name ?? a).join(', ')}.`);
  if (s?.produces?.length) extra.push(`Trains: ${s.produces.map(unitName).join(', ')}.`);
  const keys: [string, string][] = [];
  if (opts.hotkey) keys.push([opts.hotkey, u ? 'Train' : 'Place']);
  if (u) keys.push(['Shift', '×5'], ['Right-click', 'Cancel one']);
  return {
    title: unitName(type),
    sub: u ? `Tier ${u.tier ?? 1} · ${u.domain === 'naval' ? 'Naval' : u.domain === 'air' ? 'Air' : 'Ground'} unit${opts.queued ? ` · ${opts.queued} queued` : ''}` : `Tier ${s?.tier ?? 1} structure`,
    icon: opts.icon,
    costs,
    body: [ROLE[type] ?? '', ...extra].filter(Boolean),
    rows,
    keys,
    warn: opts.locked ?? (cost > opts.supply ? `Need ${Math.ceil(cost - opts.supply)} more supply` : undefined),
  };
}

/** Tooltip for an ability button. */
export function abilityTip(id: string, opts: { hotkey?: string; cooldownLeft: number; casters: number; ready: number; icon?: string; active?: boolean }): TipContent {
  const a = ABILITY_DATA[id];
  const costs: TipContent['costs'] = [];
  if (a?.cost) costs.push({ kind: 'supply', text: `${a.cost}` });
  if (a) costs.push({ kind: 'time', text: `${a.cooldown}s cooldown` });
  const facts: string[] = [];
  if (a?.duration) facts.push(`lasts ${a.duration}s`);
  if (a?.radius) facts.push(`${a.radius} m radius`);
  if (a?.range) facts.push(`range ${a.range} m`);
  return {
    title: a?.name ?? id,
    sub: `${a?.target === 'self' ? 'Instant' : a?.target === 'point' ? 'Target a spot on the map' : 'Target a unit'} · ${opts.ready}/${opts.casters} ready${opts.active ? ' · active' : ''}`,
    icon: opts.icon,
    costs,
    body: [ABILITY_TEXT[id] ?? '', facts.length ? `${facts.join(', ')[0].toUpperCase()}${facts.join(', ').slice(1)}.` : ''].filter(Boolean),
    keys: opts.hotkey ? [[opts.hotkey, 'Use'], ['Shift', 'Queue']] : undefined,
    warn: opts.ready === 0 ? `Recharging: ${Math.ceil(opts.cooldownLeft)}s` : undefined,
  };
}
