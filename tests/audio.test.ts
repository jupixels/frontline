import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import unitsJson from '../data/units.json';
import weaponsJson from '../data/weapons.json';
import { ALL_SOUNDS, SOUNDS, UNITS, WEAPONS, filesOf, unitAudio, voiceLine, weaponAudio } from '../src/audio/bank';
import { BATTLE_ENTER, BATTLE_EXIT, BATTLE_MIN_HOLD, Intensity, nextCombatState } from '../src/audio/music';
import { getVolume, setVolume } from '../src/audio/settings';
import { spatialize, type Listener } from '../src/audio/spatial';

const ROSTER = [
  'rifleman', 'sniper', 'at_soldier', 'jeep', 'ifv', 'tank_mbt', 'tank_light', 'aa_tank', 'rocket_truck', 'artillery',
  'heli_attack', 'heli_transport', 'jet_fighter', 'bomber', 'patrol_boat', 'destroyer', 'cruiser', 'submarine', 'transport_ship',
];

describe('sound bank', () => {
  it('every referenced file exists in public/assets', () => {
    const missing = filesOf(ALL_SOUNDS).filter((p) => !existsSync(join('public', 'assets', p)));
    expect(missing).toEqual([]);
  });

  it('covers the whole unit roster', () => {
    for (const t of ROSTER) {
      expect(UNITS[t], t).toBeDefined();
      const u = UNITS[t];
      expect(SOUNDS[u.death]).toBeDefined();
      expect(SOUNDS[voiceLine(u.voice, 'action')]).toBeDefined();
      if (u.weapon) expect(WEAPONS[u.weapon], `${t} weapon ${u.weapon}`).toBeDefined();
    }
  });

  it('maps every unit and weapon in data/', () => {
    expect(Object.keys(unitsJson).filter((t) => !UNITS[t])).toEqual([]);
    expect(Object.keys(weaponsJson).filter((w) => !WEAPONS[w])).toEqual([]);
    for (const [t, u] of Object.entries(unitsJson) as [string, { weapons?: string[] }][]) {
      if (u.weapons?.length) expect(u.weapons, t).toContain(UNITS[t].weapon);
    }
  });

  it('resolves unknown weapon ids by keyword, then by shooter', () => {
    expect(weaponAudio('120mm_tank_cannon').fire).toBe('cannon');
    expect(weaponAudio('m2_hmg').fire).toBe('mg');
    expect(weaponAudio('mk48_torpedo').impact).toBe('water_explosion');
    expect(weaponAudio('mystery', 'artillery').fire).toBe('howitzer');
    expect(weaponAudio('mystery').fire).toBe('rifle');
    for (const w of ['x_torpedo', 'depth_x', 'snipe', 'bomb_x', 'mortar', 'rocket_x', 'missile_x', 'deck_x', 'flak_x', 'cannon_x', 'mg_x', 'carbine']) {
      expect(weaponAudio(w), w).toBeDefined();
    }
  });

  it('guesses unlisted unit types from their data', () => {
    expect(unitAudio('frigate', { frigate: { domain: 'naval', armor: 'naval' } }).voice).toBe('naval');
    expect(unitAudio('apc', { apc: { domain: 'ground', armor: 'light' } }).engine).toBeDefined();
    expect(unitAudio('nothing').death).toBe('death_infantry');
  });
});

describe('spatialize', () => {
  const l: Listener = { x: 0, z: 0, zoom: 110, yaw: 0 };

  it('is loudest at the camera target and silent out of range', () => {
    const near = spatialize(l, 0, 0, 200);
    const mid = spatialize(l, 100, 0, 200);
    expect(near.gain).toBeGreaterThan(mid.gain);
    expect(spatialize(l, 1000, 0, 200).gain).toBe(0);
  });

  it('pans by screen side and follows camera yaw', () => {
    // yaw 0: camera looks toward -z, so +x is screen-right.
    expect(spatialize(l, 50, 0, 300).pan).toBeGreaterThan(0);
    expect(spatialize(l, -50, 0, 300).pan).toBeLessThan(0);
    // Rotated 180°: +x is now screen-left.
    expect(spatialize({ ...l, yaw: Math.PI }, 50, 0, 300).pan).toBeLessThan(0);
  });

  it('muffles distant sounds', () => {
    expect(spatialize(l, 150, 0, 300).cutoff).toBeLessThan(spatialize(l, 0, 0, 300).cutoff);
  });
});

describe('music intensity', () => {
  it('decays by half per half-life', () => {
    const i = new Intensity(10);
    i.add(8);
    i.decay(10);
    expect(i.value).toBeCloseTo(4);
  });

  it('switches with hysteresis and a minimum battle hold', () => {
    expect(nextCombatState('calm', BATTLE_ENTER - 1, 0)).toBe('calm');
    expect(nextCombatState('calm', BATTLE_ENTER, 0)).toBe('battle');
    expect(nextCombatState('battle', BATTLE_EXIT - 1, BATTLE_MIN_HOLD - 1)).toBe('battle');
    expect(nextCombatState('battle', BATTLE_EXIT + 1, BATTLE_MIN_HOLD + 1)).toBe('battle');
    expect(nextCombatState('battle', BATTLE_EXIT - 1, BATTLE_MIN_HOLD + 1)).toBe('calm');
  });
});

describe('audio settings', () => {
  it('clamps volumes to 0..1', () => {
    setVolume('music', 3);
    expect(getVolume('music')).toBe(1);
    setVolume('music', -1);
    expect(getVolume('music')).toBe(0);
  });
});
