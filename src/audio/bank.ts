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

const v = (dir: string, stem: string, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `sounds/${dir}/${stem}${String(i + from).padStart(2, '0')}.mp3`);
const f = (...names: string[]) => names.map((n) => `sounds/${n}.mp3`);

export const SOUNDS = {
  // --- small arms ---
  rifle: {
    files: [...f('weapons/m4_ar15_single_near_1', 'weapons/m4_ar15_single_near_2', 'weapons/ak47_single_near_1', 'weapons/ak47_single_near_2', 'weapons/ak47_single_near_3'), ...v('ww2', 'rifle_shot_', 4)],
    far: f('weapons/m4_ar15_single_far_1', 'weapons/m4_ar15_single_far_2', 'weapons/ak47_single_far_1', 'weapons/ak47_single_far_2'),
    farFrom: 80, volume: 0.32, vary: 0.08, range: 220, maxVoices: 6, cooldown: 0.05,
  },
  mg: {
    files: f('weapons/ak47_burst_short_near_1', 'weapons/ak47_burst_short_near_2', 'weapons/smg_burst_short_near_1', 'weapons/smg_burst_short_near_2', 'weapons/smg_burst_short_near_3', 'ww2/mg_burst_01', 'ww2/mg_burst_02'),
    far: f('weapons/ak47_burst_short_far_1', 'weapons/ak47_burst_short_far_2', 'weapons/ak47_burst_short_far_3', 'weapons/smg_burst_long_far_1'),
    farFrom: 90, volume: 0.36, vary: 0.06, range: 260, maxVoices: 4, cooldown: 0.12,
  },
  sniper: {
    files: f('weapons/sniper_rifle_near_1', 'weapons/sniper_rifle_near_2', 'weapons/sniper_rifle2_near_1', 'weapons/sniper_rifle2_near_2'),
    far: f('weapons/sniper_rifle_far_1', 'weapons/sniper_rifle_far_2'),
    farFrom: 100, volume: 0.5, vary: 0.04, range: 320, maxVoices: 3,
  },
  autocannon: {
    files: f('bangs/shot_01', 'bangs/shot_02', 'bangs/shot_03'),
    volume: 0.42, vary: 0.1, rate: 1.15, range: 280, maxVoices: 5, cooldown: 0.06,
  },
  // --- heavy guns ---
  cannon: {
    files: v('bangs', 'cannon_', 5),
    far: f('explosions/explosion_distant'),
    farFrom: 160, volume: 0.6, vary: 0.07, range: 380, maxVoices: 4, cooldown: 0.08,
  },
  howitzer: {
    files: v('ww2', 'howitzer_', 2),
    far: v('ww2', 'artillery_', 2),
    farFrom: 150, volume: 0.7, vary: 0.06, range: 520, maxVoices: 3, cooldown: 0.1,
  },
  naval_gun: {
    files: f('naval/naval_GunShot', 'naval/cannon_fire_1'),
    far: f('naval/naval_GunShotGverb'),
    farFrom: 150, volume: 0.6, vary: 0.06, range: 480, maxVoices: 3, cooldown: 0.1,
  },
  naval_mg: { files: f('naval/gun3Machinegun', 'naval/gun2Heavy'), volume: 0.4, vary: 0.1, range: 220, maxVoices: 4, cooldown: 0.07 },
  // --- missiles / rockets ---
  missile: { files: f('vehicles/missile_launch'), volume: 0.45, vary: 0.08, range: 320, maxVoices: 3, cooldown: 0.15, duration: 2.2 },
  rocket_salvo: { files: f('vehicles/rocket_launch'), volume: 0.55, vary: 0.05, range: 420, maxVoices: 2, cooldown: 0.4 },
  torpedo: { files: f('naval/torpedo1'), volume: 0.5, vary: 0.05, range: 260, maxVoices: 2 },
  // --- impacts / hits ---
  hit_metal: { files: [...v('impacts', 'metal_medium_', 5), ...v('impacts', 'metal_heavy_', 5)], volume: 0.3, vary: 0.12, range: 140, maxVoices: 4, cooldown: 0.05 },
  explosion_small: { files: v('explosions', 'explosion_crunch_', 5), volume: 0.55, vary: 0.1, range: 320, maxVoices: 5, cooldown: 0.05 },
  explosion_shell: {
    files: [...v('bangs', 'bang_', 10), ...v('ww2', 'artillery_', 6)],
    far: f('explosions/explosion_distant', 'explosions/explosion_muffled_distant'),
    farFrom: 170, volume: 0.65, vary: 0.08, range: 480, maxVoices: 5, cooldown: 0.05, duck: 0.25,
  },
  explosion_big: {
    files: f('explosions/explosion_chunky', 'explosions/explosion_deep_01', 'explosions/explosion_deep_02'),
    far: f('explosions/explosion_muffled_distant'),
    farFrom: 180, volume: 0.85, vary: 0.06, range: 600, maxVoices: 3, cooldown: 0.1, duck: 0.5,
  },
  water_explosion: {
    files: v('naval', 'naval_WaterSurfaceExplosion', 4),
    volume: 0.6, vary: 0.08, range: 420, maxVoices: 3, cooldown: 0.08, duck: 0.2,
  },
  splash: { files: f('naval/naval_Splash', 'naval/cannon_miss_1'), volume: 0.45, vary: 0.1, range: 300, maxVoices: 3 },
  ship_hit: { files: f('naval/cannon_hit_ship_short', 'naval/naval_ExplosionMetal'), volume: 0.6, vary: 0.08, range: 420, maxVoices: 3 },
  // --- deaths ---
  death_infantry: { files: f('naval/scream1', 'naval/scream2', 'naval/scream3'), volume: 0.18, vary: 0.12, range: 90, maxVoices: 2, cooldown: 0.6 },
  death_vehicle: { files: [...v('explosions', 'explosion_crunch_', 5), 'sounds/explosions/explosion_deep_02.mp3'], volume: 0.7, vary: 0.08, range: 450, maxVoices: 3, duck: 0.3 },
  death_tank: { files: f('explosions/explosion_chunky', 'explosions/explosion_deep_01'), far: f('explosions/explosion_muffled_distant'), farFrom: 180, volume: 0.9, vary: 0.05, range: 600, maxVoices: 2, duck: 0.55 },
  death_air: { files: f('naval/aiplaneexplode', 'explosions/explosion_deep_01'), volume: 0.8, vary: 0.06, range: 600, maxVoices: 2, duck: 0.4 },
  death_boat: { files: f('naval/boatexplode', 'naval/shipexplode'), volume: 0.8, vary: 0.05, range: 500, maxVoices: 2, duck: 0.4 },
  death_ship: { files: f('naval/ship_destroyed_short'), volume: 0.9, vary: 0.03, range: 700, maxVoices: 1, duck: 0.6 },
  // --- engines / loops ---
  engine_low: { files: v('engines', 'engine_low_', 5), volume: 0.3, range: 160 },
  engine_large: { files: v('engines', 'engine_large_', 5), volume: 0.36, range: 200 },
  rotor: { files: f('vehicles/helicopter_loop'), volume: 0.42, range: 300 },
  ship_engine: { files: f('naval/naval_BattleShipMovementAmbient'), volume: 0.3, range: 260 },
  jet_flyby: { files: f('vehicles/jet_takeoff_flyby_CC-BY'), volume: 0.55, vary: 0.08, range: 600, maxVoices: 2, cooldown: 1.5 },
  smoke_pop: { files: f('bangs/shot_01', 'bangs/shot_02', 'bangs/shot_03'), volume: 0.3, rate: 0.6, vary: 0.08, range: 200, maxVoices: 2, cooldown: 0.1 },
  // --- ambience ---
  battle_distant: { files: v('ww2', 'battle_distant_', 4), volume: 0.12, vary: 0.05, flat: true, maxVoices: 2 },
  // --- voices & alerts (flat, voice bus) ---
  radio_static: { files: f('alerts/radio_static_6s'), volume: 0.16, flat: true, bus: 'voice', offsetMax: 5.2, duration: 0.35, maxVoices: 2, cooldown: 0 },
  radio_morse: { files: f('ww2/radio_morse_02'), volume: 0.2, flat: true, bus: 'voice', maxVoices: 1 },
  siren: { files: f('alerts/siren_alarm'), volume: 0.35, flat: true, bus: 'voice', maxVoices: 1 },
  ground_select: { files: f('voices/artil/artil.select'), volume: 0.7, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  ground_action: { files: f('voices/artil/artil.action'), volume: 0.7, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  ground_ready: { files: f('voices/artil/artil.ready'), volume: 0.75, flat: true, bus: 'voice', maxVoices: 1 },
  ground_die: { files: f('voices/artil/artil.die'), volume: 0.6, flat: true, bus: 'voice', maxVoices: 1 },
  naval_select: { files: f('voices/destroyer/destroyer.select'), volume: 0.7, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  naval_action: { files: f('voices/destroyer/destroyer.action'), volume: 0.7, flat: true, bus: 'voice', maxVoices: 1, vary: 0.02 },
  naval_ready: { files: f('voices/destroyer/destroyer.ready'), volume: 0.75, flat: true, bus: 'voice', maxVoices: 1 },
  naval_die: { files: f('voices/destroyer/destroyer.die'), volume: 0.6, flat: true, bus: 'voice', maxVoices: 1 },
  under_attack: { files: f('voices/destroyer/destroyer.underattack'), volume: 0.85, flat: true, bus: 'voice', maxVoices: 1 },
  airfield_select: { files: f('voices/aircraftfactory/aircraftfactory.select'), volume: 0.7, flat: true, bus: 'voice', maxVoices: 1 },
  shipyard_select: { files: f('voices/shipyard/shipyard.select'), volume: 0.7, flat: true, bus: 'voice', maxVoices: 1 },
  // --- UI (flat, sfx bus) ---
  ui_click: { files: v('ui', 'click_', 5), volume: 0.4, flat: true, vary: 0.03, maxVoices: 2 },
  ui_select: { files: v('ui', 'select_', 2), volume: 0.35, flat: true, vary: 0.03, maxVoices: 2 },
  ui_confirm: { files: v('ui', 'confirm_', 4), volume: 0.45, flat: true, vary: 0.03, maxVoices: 2 },
  ui_error: { files: v('ui', 'error_', 3), volume: 0.45, flat: true, maxVoices: 1, cooldown: 0.2 },
  ui_open: { files: v('ui', 'open_', 4), volume: 0.4, flat: true, maxVoices: 1 },
  ui_close: { files: v('ui', 'close_', 4), volume: 0.4, flat: true, maxVoices: 1 },
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
