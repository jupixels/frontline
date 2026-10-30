// Sound data tables: which files make up each sound, how they behave, and which sounds each unit
// type and weapon uses. Pure data + lookups (no Web Audio) so it can be unit tested.

import type { ArmorClass, Domain } from '../shared/data';

export interface SoundDef {
  /** Variants (paths under public/assets/). One is picked at random per play. */
  files: string[];
  /** Variants used when the listener is farther than `farFrom` meters. */
  far?: string[];
  farFrom?: number;
  /** Base gain 0..1. */
  volume: number;
  /** Random pitch spread, ± fraction of playback rate. */
  vary?: number;
  /** Random volume spread, ± fraction. */
  volVary?: number;
  /** Base playback rate. */
  rate?: number;
  /** Max audible ground distance (m) at default zoom. */
  range?: number;
  /** Max simultaneous instances of this sound. */
  maxVoices?: number;
  /** Min seconds between starts. */
  cooldown?: number;
  bus?: 'sfx' | 'voice';
  /** Plays centered at full volume (UI, voices, alerts). */
  flat?: boolean;
  /** Music duck depth (0..1) when this plays close and loud. */
  duck?: number;
  /** Play only part of the file: random start in [0, offsetMax], for `duration` seconds. */
  offsetMax?: number;
  duration?: number;
}

/** Variants made with ElevenLabs by tools/build-assets.mjs: sounds/gen/<id>_01.mp3 ... */
const g = (id: string, n: number) => Array.from({ length: n }, (_, i) => `sounds/gen/${id}_${String(i + 1).padStart(2, '0')}.mp3`);

export const SOUNDS = {
  // --- small arms ---
  rifle: { files: g('rifle', 3), far: g('rifle_far', 2), farFrom: 80, volume: 0.3, vary: 0.08, range: 220, maxVoices: 6, cooldown: 0.05 },
  mg: { files: g('mg', 3), far: g('mg_far', 2), farFrom: 90, volume: 0.32, vary: 0.06, range: 260, maxVoices: 4, cooldown: 0.12 },
  sniper: { files: g('sniper', 2), far: g('sniper_far', 1), farFrom: 100, volume: 0.45, vary: 0.04, range: 320, maxVoices: 3 },
  autocannon: { files: g('autocannon', 3), volume: 0.28, vary: 0.08, range: 280, maxVoices: 5, cooldown: 0.06 },
  // --- heavy guns ---
  cannon: { files: g('cannon', 3), far: g('cannon_far', 1), farFrom: 160, volume: 0.42, vary: 0.07, range: 380, maxVoices: 4, cooldown: 0.08 },
  howitzer: { files: g('howitzer', 2), far: g('howitzer_far', 2), farFrom: 150, volume: 0.67, vary: 0.06, range: 520, maxVoices: 3, cooldown: 0.1 },
  naval_gun: { files: g('naval_gun', 2), far: g('naval_gun_far', 1), farFrom: 150, volume: 0.64, vary: 0.06, range: 480, maxVoices: 3, cooldown: 0.1 },
  naval_mg: { files: g('naval_mg', 2), volume: 0.28, vary: 0.1, range: 220, maxVoices: 4, cooldown: 0.07 },
  // --- missiles / rockets ---
  missile: { files: g('missile', 3), volume: 0.4, vary: 0.08, range: 320, maxVoices: 3, cooldown: 0.15 },
  rocket_salvo: { files: g('rocket_salvo', 2), volume: 0.71, vary: 0.05, range: 420, maxVoices: 2, cooldown: 0.4 },
  torpedo: { files: g('torpedo', 1), volume: 0.62, vary: 0.05, range: 260, maxVoices: 2 },
  // --- impacts / hits ---
  hit_metal: { files: g('hit_metal', 4), volume: 0.34, vary: 0.12, range: 140, maxVoices: 4, cooldown: 0.05 },
  explosion_small: { files: g('explosion_small', 3), volume: 0.72, vary: 0.1, range: 320, maxVoices: 5, cooldown: 0.05 },
  explosion_shell: { files: g('explosion_shell', 4), far: g('explosion_shell_far', 2), farFrom: 170, volume: 0.42, vary: 0.08, range: 480, maxVoices: 5, cooldown: 0.05, duck: 0.25 },
  explosion_big: { files: g('explosion_big', 2), far: g('explosion_big_far', 1), farFrom: 180, volume: 0.38, vary: 0.06, range: 600, maxVoices: 3, cooldown: 0.1, duck: 0.5 },
  water_explosion: { files: g('water_explosion', 2), volume: 0.43, vary: 0.08, range: 420, maxVoices: 3, cooldown: 0.08, duck: 0.2 },
  splash: { files: g('splash', 2), volume: 0.5, vary: 0.1, range: 300, maxVoices: 3 },
  ship_hit: { files: g('ship_hit', 2), volume: 1, vary: 0.08, range: 420, maxVoices: 3 },
  // --- deaths ---
  death_infantry: { files: g('death_infantry', 4), volume: 0.1, vary: 0.08, range: 90, maxVoices: 2, cooldown: 0.6 },
  death_vehicle: { files: g('death_vehicle', 3), volume: 0.39, vary: 0.08, range: 450, maxVoices: 3, duck: 0.3 },
  death_tank: { files: g('death_tank', 2), far: g('explosion_big_far', 1), farFrom: 180, volume: 0.5, vary: 0.05, range: 600, maxVoices: 2, duck: 0.55 },
  death_air: { files: g('death_air', 2), volume: 0.46, vary: 0.06, range: 600, maxVoices: 2, duck: 0.4 },
  death_boat: { files: g('death_boat', 2), volume: 0.96, vary: 0.05, range: 500, maxVoices: 2, duck: 0.4 },
  death_ship: { files: g('death_ship', 1), volume: 0.88, vary: 0.03, range: 700, maxVoices: 1, duck: 0.6 },
  // --- engines / loops ---
  engine_low: { files: g('engine_low', 2), volume: 0.41, range: 160 },
  engine_large: { files: g('engine_large', 2), volume: 0.73, range: 200 },
  rotor: { files: g('rotor', 1), volume: 0.28, range: 300 },
  ship_engine: { files: g('ship_engine', 1), volume: 0.1, range: 260 },
  jet_flyby: { files: g('jet_flyby', 2), volume: 0.21, vary: 0.08, range: 600, maxVoices: 2, cooldown: 1.5 },
  smoke_pop: { files: g('smoke_pop', 2), volume: 0.22, vary: 0.08, range: 200, maxVoices: 2, cooldown: 0.1 },
  // --- ambience ---
  battle_distant: { files: g('battle_distant', 3), volume: 0.07, vary: 0.05, flat: true, maxVoices: 2 },
  // --- voices & alerts (flat, voice bus) ---
  radio_static: { files: g('radio_static', 1), volume: 0.51, flat: true, bus: 'voice', offsetMax: 2.4, duration: 0.35, maxVoices: 2, cooldown: 0 },
  radio_morse: { files: g('radio_morse', 1), volume: 0.13, flat: true, bus: 'voice', maxVoices: 1 },
  siren: { files: g('siren', 1), volume: 0.17, flat: true, bus: 'voice', maxVoices: 1 },
  ground_select: { files: g('voice/ground_select', 4), volume: 0.53, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  ground_action: { files: g('voice/ground_action', 4), volume: 0.39, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  ground_ready: { files: g('voice/ground_ready', 3), volume: 0.6, flat: true, bus: 'voice', maxVoices: 1 },
  ground_die: { files: g('voice/ground_die', 3), volume: 0.68, flat: true, bus: 'voice', maxVoices: 1 },
  naval_select: { files: g('voice/naval_select', 3), volume: 0.45, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  naval_action: { files: g('voice/naval_action', 3), volume: 0.61, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  naval_ready: { files: g('voice/naval_ready', 2), volume: 0.41, flat: true, bus: 'voice', maxVoices: 1 },
  naval_die: { files: g('voice/naval_die', 2), volume: 0.64, flat: true, bus: 'voice', maxVoices: 1 },
  under_attack: { files: g('voice/under_attack', 3), volume: 0.45, flat: true, bus: 'voice', maxVoices: 1 },
  airfield_select: { files: g('voice/airfield_select', 2), volume: 0.95, flat: true, bus: 'voice', maxVoices: 1 },
  shipyard_select: { files: g('voice/shipyard_select', 2), volume: 1, flat: true, bus: 'voice', maxVoices: 1 },
  // --- UI (flat, sfx bus) ---
  ui_click: { files: g('ui_click', 2), volume: 0.81, flat: true, vary: 0.03, maxVoices: 2 },
  ui_select: { files: g('ui_select', 2), volume: 0.74, flat: true, vary: 0.03, maxVoices: 2 },
  ui_confirm: { files: g('ui_confirm', 3), volume: 0.87, flat: true, vary: 0.03, maxVoices: 2 },
  ui_error: { files: g('ui_error', 2), volume: 0.3, flat: true, maxVoices: 1, cooldown: 0.2 },
  ui_open: { files: g('ui_open', 2), volume: 0.69, flat: true, maxVoices: 1 },
  ui_close: { files: g('ui_close', 2), volume: 0.59, flat: true, maxVoices: 1 },
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUNDS;
export type UiSound = 'click' | 'select' | 'confirm' | 'error' | 'open' | 'close';

export function soundDef(id: SoundId): SoundDef {
  return SOUNDS[id];
}

// ---------------------------------------------------------------------------------------------
// Weapons

export interface WeaponAudio {
  fire: SoundId;
  /** Played by `impact` events (explosive rounds). Bullets leave this out. */
  impact?: SoundId;
}

/** Known weapon ids. Unknown ids fall back to keyword matching, then to the firing unit's default. */
export const WEAPONS: Record<string, WeaponAudio> = {
  // ids from data/weapons.json
  rifle: { fire: 'rifle' },
  pistol: { fire: 'rifle' },
  sniper_rifle: { fire: 'sniper' },
  at_rocket: { fire: 'missile', impact: 'explosion_small' },
  jeep_mg: { fire: 'mg' },
  autocannon: { fire: 'autocannon' },
  atgm: { fire: 'missile', impact: 'explosion_small' },
  light_cannon: { fire: 'cannon', impact: 'explosion_small' },
  tank_cannon: { fire: 'cannon', impact: 'explosion_small' },
  coax_mg: { fire: 'mg' },
  aa_gun: { fire: 'autocannon' },
  mlrs: { fire: 'rocket_salvo', impact: 'explosion_shell' },
  howitzer: { fire: 'howitzer', impact: 'explosion_shell' },
  heli_rockets: { fire: 'missile', impact: 'explosion_small' },
  heli_gun: { fire: 'mg' },
  door_gun: { fire: 'mg' },
  aa_missile: { fire: 'missile', impact: 'explosion_small' },
  jet_cannon: { fire: 'autocannon' },
  bombs: { fire: 'jet_flyby', impact: 'explosion_big' },
  boat_gun: { fire: 'naval_mg' },
  naval_gun: { fire: 'naval_gun', impact: 'explosion_shell' },
  depth_charge: { fire: 'splash', impact: 'water_explosion' },
  sam: { fire: 'missile', impact: 'explosion_small' },
  heavy_naval_gun: { fire: 'naval_gun', impact: 'explosion_big' },
  torpedo: { fire: 'torpedo', impact: 'water_explosion' },
  ship_mg: { fire: 'naval_mg' },
  cruise_missile: { fire: 'missile', impact: 'explosion_big' },
  tower_mg: { fire: 'mg' },
  // aliases for future weapons
  mg: { fire: 'mg' },
  cannon: { fire: 'cannon', impact: 'explosion_small' },
  rockets: { fire: 'rocket_salvo', impact: 'explosion_shell' },
  bomb: { fire: 'jet_flyby', impact: 'explosion_big' },
  barrage: { fire: 'howitzer', impact: 'explosion_shell' },
};

/** Keyword rules for weapon ids not in WEAPONS, checked in order. */
const WEAPON_KEYWORDS: [RegExp, WeaponAudio][] = [
  [/torpedo/, WEAPONS.torpedo],
  [/depth/, WEAPONS.depth_charge],
  [/snip/, WEAPONS.sniper_rifle],
  [/bomb/, WEAPONS.bomb],
  [/howitzer|artiller|mortar|shell/, WEAPONS.howitzer],
  [/rocket|mlrs|salvo/, WEAPONS.rockets],
  [/missile|atgm|sam|hellfire|tow\b/, WEAPONS.at_rocket],
  [/naval|deck|ship/, WEAPONS.naval_gun],
  [/autocannon|flak|aa/, WEAPONS.autocannon],
  [/cannon|gun_?main|tank/, WEAPONS.cannon],
  [/mg|machine|chain|minigun|smg/, WEAPONS.mg],
  [/rifle|carbine|pistol|small/, WEAPONS.rifle],
];

export function weaponAudio(weapon: string, shooterType?: string, units?: UnitAudioLookup): WeaponAudio {
  const known = WEAPONS[weapon];
  if (known) return known;
  const w = weapon.toLowerCase();
  for (const [re, a] of WEAPON_KEYWORDS) if (re.test(w)) return a;
  const u = shooterType ? unitAudio(shooterType, units) : undefined;
  return u?.weapon ? WEAPONS[u.weapon] ?? WEAPONS.rifle : WEAPONS.rifle;
}

// ---------------------------------------------------------------------------------------------
// Units

export type VoiceSet = 'ground' | 'naval';

export interface EngineAudio {
  sound: 'engine_low' | 'engine_large' | 'rotor' | 'ship_engine';
  rate: number;
  volume: number;
  /** Gain multiplier while stopped (0 = silent when idle). */
  idle: number;
}

export interface UnitAudio {
  /** Default weapon id when a `fired` event's weapon isn't recognised. */
  weapon?: string;
  death: SoundId;
  /** Which radio voice lines answer for this unit (select / order / ready). */
  voice: VoiceSet;
  engine?: EngineAudio;
  /** Jets: periodic flyby one-shot while moving instead of an engine loop. */
  flyby?: boolean;
  /** True if bullets bounce off it (metal hit sound on `hit`). */
  armored?: boolean;
}

const eng = (sound: EngineAudio['sound'], rate: number, volume: number, idle = 0.35): EngineAudio => ({ sound, rate, volume, idle });

export const UNITS: Record<string, UnitAudio> = {
  rifleman: { weapon: 'rifle', death: 'death_infantry', voice: 'ground' },
  sniper: { weapon: 'sniper_rifle', death: 'death_infantry', voice: 'ground' },
  at_soldier: { weapon: 'at_rocket', death: 'death_infantry', voice: 'ground' },
  engineer: { weapon: 'pistol', death: 'death_infantry', voice: 'ground' },
  jeep: { weapon: 'jeep_mg', death: 'death_vehicle', voice: 'ground', engine: eng('engine_low', 1.25, 0.8), armored: true },
  scout_car: { weapon: 'autocannon', death: 'death_vehicle', voice: 'ground', engine: eng('engine_low', 1.15, 0.85), armored: true },
  supply_truck: { death: 'death_vehicle', voice: 'ground', engine: eng('engine_low', 0.9, 0.9), armored: true },
  ifv: { weapon: 'autocannon', death: 'death_vehicle', voice: 'ground', engine: eng('engine_low', 0.95, 1), armored: true },
  tank_mbt: { weapon: 'tank_cannon', death: 'death_tank', voice: 'ground', engine: eng('engine_large', 0.85, 1.1), armored: true },
  tank_light: { weapon: 'light_cannon', death: 'death_tank', voice: 'ground', engine: eng('engine_large', 1.05, 0.95), armored: true },
  aa_tank: { weapon: 'aa_gun', death: 'death_tank', voice: 'ground', engine: eng('engine_large', 0.95, 0.95), armored: true },
  rocket_truck: { weapon: 'mlrs', death: 'death_vehicle', voice: 'ground', engine: eng('engine_low', 0.85, 1), armored: true },
  artillery: { weapon: 'howitzer', death: 'death_tank', voice: 'ground', engine: eng('engine_large', 0.8, 1), armored: true },
  heli_attack: { weapon: 'heli_gun', death: 'death_air', voice: 'ground', engine: eng('rotor', 1.05, 1, 1), armored: true },
  heli_transport: { weapon: 'door_gun', death: 'death_air', voice: 'ground', engine: eng('rotor', 0.9, 1.1, 1), armored: true },
  jet_fighter: { weapon: 'aa_missile', death: 'death_air', voice: 'ground', flyby: true, armored: true },
  bomber: { weapon: 'bombs', death: 'death_air', voice: 'ground', flyby: true, armored: true },
  patrol_boat: { weapon: 'boat_gun', death: 'death_boat', voice: 'naval', engine: eng('ship_engine', 1.45, 0.8, 0.4), armored: true },
  destroyer: { weapon: 'naval_gun', death: 'death_ship', voice: 'naval', engine: eng('ship_engine', 1, 1, 0.5), armored: true },
  cruiser: { weapon: 'heavy_naval_gun', death: 'death_ship', voice: 'naval', engine: eng('ship_engine', 0.85, 1.15, 0.5), armored: true },
  submarine: { weapon: 'torpedo', death: 'death_ship', voice: 'naval', engine: eng('ship_engine', 0.6, 0.45, 0.3), armored: true },
  transport_ship: { weapon: 'ship_mg', death: 'death_ship', voice: 'naval', engine: eng('ship_engine', 0.8, 1, 0.5), armored: true },
};

/** Minimal unit info for fallbacks (matches data/units.json fields). */
export type UnitAudioLookup = Record<string, { domain: Domain; armor: ArmorClass } | undefined>;

const FALLBACK: Record<string, UnitAudio> = {
  infantry: UNITS.rifleman,
  ground: UNITS.ifv,
  heavy: UNITS.tank_mbt,
  air: UNITS.heli_attack,
  naval: UNITS.destroyer,
};

/** Audio profile for a unit type: exact entry, else guessed from its data (domain/armor), else infantry. */
export function unitAudio(type: string, units?: UnitAudioLookup): UnitAudio {
  const known = UNITS[type];
  if (known) return known;
  const def = units?.[type];
  if (!def) return FALLBACK.infantry;
  if (def.domain === 'naval') return FALLBACK.naval;
  if (def.domain === 'air') return FALLBACK.air;
  if (def.armor === 'infantry') return FALLBACK.infantry;
  return def.armor === 'heavy' ? FALLBACK.heavy : FALLBACK.ground;
}

/** Voice line sound for a unit type. Factories get their own select lines. */
export function voiceLine(set: VoiceSet, line: 'select' | 'action' | 'ready' | 'die'): SoundId {
  return `${set}_${line}` as SoundId;
}

/** Select line for structures that have one (matched by type keyword). */
export function structureSelectLine(type: string): SoundId | undefined {
  if (/air(field|port)|aircraft|helipad/.test(type)) return 'airfield_select';
  if (/naval|ship|dock|port/.test(type)) return 'shipyard_select';
  return undefined;
}

/** Every file referenced by a set of sounds (for preloading). */
export function filesOf(ids: Iterable<SoundId>): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const d: SoundDef = SOUNDS[id];
    for (const p of d.files) out.add(p);
    for (const p of d.far ?? []) out.add(p);
  }
  return [...out];
}

export const ALL_SOUNDS = Object.keys(SOUNDS) as SoundId[];
