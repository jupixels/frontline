// BALANCE=1 npx vitest run tests/tools/balance-matrix.test.ts --silent=false
import { it } from 'vitest';
import { battle, cost, mixed, mono, type Army } from '../balance.helpers';

export const MIX = { rifleman: 0.2, at_soldier: 0.15, tank_mbt: 0.25, ifv: 0.15, aa_tank: 0.1, artillery: 0.1, scout_car: 0.05 };

it.skipIf(!process.env.BALANCE)('mono vs mixed matrix', () => {
  const budget = Number(process.env.BUDGET ?? 5000);
  const mix = mixed(budget, MIX);
  console.log('mixed', JSON.stringify(mix), cost(mix));
  for (const t of ['rifleman', 'at_soldier', 'sniper', 'jeep', 'scout_car', 'ifv', 'tank_light', 'tank_mbt', 'aa_tank', 'rocket_truck', 'artillery', 'heli_attack']) {
    const m = mono(t, cost(mix));
    const r = battle(m, mix);
    console.log(`${t.padEnd(13)} x${m[0][1]} (${cost(m)})  mono=${r.a.toFixed(2)} mixed=${r.b.toFixed(2)} ${r.seconds}s ${r.b > r.a ? 'ok' : 'MONO WINS'}`);
  }
}, 600000);

it.skipIf(!process.env.BALANCE)('counters', () => {
  const pairs: [string, string][] = (process.env.PAIRS ?? 'rifleman:scout_car,rifleman:jeep,at_soldier:rifleman,tank_mbt:at_soldier,tank_light:at_soldier,ifv:tank_mbt,jeep:tank_light,scout_car:tank_light,sniper:jeep,artillery:scout_car,rocket_truck:jeep,heli_attack:aa_tank,aa_tank:tank_mbt,patrol_boat:destroyer,submarine:destroyer,cruiser:submarine,destroyer:cruiser,transport_ship:patrol_boat,jet_fighter:aa_tank,bomber:jet_fighter').split(',').map((p) => p.split(':') as [string, string]);
  const budget = Number(process.env.BUDGET ?? 3000);
  for (const [unit, counter] of pairs) {
    const a: Army = mono(unit, budget);
    const b: Army = mono(counter, cost(a));
    const r = battle(a, b);
    console.log(`${unit.padEnd(14)} x${a[0][1]} vs ${counter.padEnd(12)} x${b[0][1]}: unit=${r.a.toFixed(2)} counter=${r.b.toFixed(2)} ${r.seconds}s ${r.b > r.a + 0.2 ? 'ok' : 'WEAK'}`);
  }
}, 600000);
