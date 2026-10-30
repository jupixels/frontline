// Anti-degenerate balance checks (GAME_PLAN §8b). Headless fights on open ground:
//  - no single-unit-type army beats a combined-arms army of equal cost
//  - every unit has a real counter (wins clearly at equal cost)
// Full AI-vs-AI matches (comeback, no stalemates) are in balance.matches.test.ts.

import { describe, expect, it } from 'vitest';
import { battle, cost, mixed, mono } from './balance.helpers';

/** The combined-arms reference army, as cost shares. */
export const MIX = { rifleman: 0.2, at_soldier: 0.15, tank_mbt: 0.25, ifv: 0.15, aa_tank: 0.1, artillery: 0.1, scout_car: 0.05 };

const MONO_TYPES = ['rifleman', 'at_soldier', 'sniper', 'jeep', 'scout_car', 'ifv', 'tank_light', 'tank_mbt', 'aa_tank', 'rocket_truck', 'artillery', 'heli_attack'];

describe('no single-unit army beats combined arms', () => {
  const army = mixed(4500, MIX);
  it.each(MONO_TYPES)('%s spam loses to a mixed army of equal cost', (type) => {
    const m = mono(type, cost(army));
    expect(Math.abs(cost(m) - cost(army)) / cost(army)).toBeLessThan(0.12);
    const r = battle(m, army, { seed: 5 });
    expect(r.b, `mono ${type}: mono ${r.a.toFixed(2)} vs mixed ${r.b.toFixed(2)}`).toBeGreaterThan(r.a);
  }, 60000);
});

/** [unit, its counter]: at equal cost the counter must win with a real margin. */
const COUNTERS: [string, string][] = [
  ['rifleman', 'jeep'],
  ['rifleman', 'scout_car'],
  ['at_soldier', 'rifleman'],
  ['sniper', 'jeep'],
  ['tank_mbt', 'at_soldier'],
  ['tank_light', 'at_soldier'],
  ['ifv', 'tank_mbt'],
  ['jeep', 'tank_light'],
  ['scout_car', 'tank_light'],
  ['artillery', 'scout_car'],
  ['rocket_truck', 'jeep'],
  ['heli_attack', 'aa_tank'],
  ['aa_tank', 'tank_mbt'],
  ['jet_fighter', 'aa_tank'],
  ['bomber', 'jet_fighter'],
  ['patrol_boat', 'destroyer'],
  ['submarine', 'destroyer'],
  ['cruiser', 'submarine'],
  ['destroyer', 'cruiser'],
  ['transport_ship', 'patrol_boat'],
];

describe('every unit has a counter', () => {
  it.each(COUNTERS)('%s is countered by %s', (unit, counter) => {
    // Naval units are expensive: a bigger budget keeps whole-unit rounding fair.
    const a = mono(unit, /destroyer|cruiser|submarine|transport_ship|patrol_boat|bomber|jet/.test(unit + counter) ? 5000 : 3000);
    const b = mono(counter, cost(a));
    const r = battle(a, b, { seed: 7 });
    expect(r.b - r.a, `${unit} ${r.a.toFixed(2)} vs ${counter} ${r.b.toFixed(2)}`).toBeGreaterThan(0.2);
  }, 60000);
});
