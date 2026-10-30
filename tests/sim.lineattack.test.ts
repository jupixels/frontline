import { describe, expect, it } from 'vitest';
import { SIM_HZ, type MatchSetup } from '../src/shared/types';
import type { AnyPlayerCommand } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import type { Entity } from '../src/sim/world';
import { flatContent, twoPlayers } from './fixtures';

function flat(setup: MatchSetup = twoPlayers()): Simulation {
  const sim = new Simulation(setup, flatContent());
  for (const e of [...sim.world.entities.values()]) if (e.kind === 'unit') sim.world.remove(e.id);
  return sim;
}

function run(sim: Simulation, ticks: number, cmds: AnyPlayerCommand[] = []): void {
  for (let t = 0; t < ticks; t++) sim.step(t === 0 ? cmds : []);
}

/** 30 units: 4 rifle squads (16), 3 AT teams (6), 3 tanks, 3 IFVs, 2 light tanks. */
function mixedArmy(sim: Simulation): Entity[] {
  const w = sim.world;
  const out: Entity[] = [];
  let i = 0;
  const add = (type: string, n: number) => {
    for (let k = 0; k < n; k++, i++) out.push(w.spawnUnit(type, 0, { x: -60 + (i % 10) * 12, z: 90 + Math.floor(i / 10) * 10 }, Math.PI));
  };
  add('rifleman', 16);
  add('at_soldier', 6);
  add('tank_mbt', 3);
  add('ifv', 3);
  add('tank_light', 2);
  return out;
}

const minGap = (units: Entity[]) => {
  let m = Infinity;
  for (let a = 0; a < units.length; a++) for (let b = a + 1; b < units.length; b++) m = Math.min(m, Math.hypot(units[a].pos.x - units[b].pos.x, units[a].pos.z - units[b].pos.z) - units[a].radius - units[b].radius);
  return m;
};

describe('attacking as a frontline', () => {
  it('a 30-unit mixed line spreads out by footprint without stacking', () => {
    const sim = flat();
    const army = mixedArmy(sim);
    run(sim, 50 * SIM_HZ, [{ player: 0, cmd: { type: 'holdLine', units: army.map((u) => u.id), points: [{ x: -90, z: 40 }, { x: 90, z: 40 }] } }]);
    // Slots: infantry at least ~3 m apart along the line, vehicles further.
    const slots = army.map((u) => u.lineSlot!);
    for (let a = 0; a < army.length; a++) {
      for (let b = a + 1; b < army.length; b++) {
        const d = Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z);
        const need = army[a].armor === 'infantry' && army[b].armor === 'infantry' ? 2.8 : 5;
        expect(d, `${army[a].type} vs ${army[b].type}`).toBeGreaterThan(need);
      }
    }
    // And on the ground nobody is piled on anybody.
    expect(minGap(army)).toBeGreaterThan(-0.5);
  });

  // (Kept short of the enemy HQ at (120, -120): buildings in reach halt the line too.)
  it('an advance marches together at the slowest pace, keeping spacing, and arrives together', () => {
    const sim = flat();
    const w = sim.world;
    const army = [...mixedArmy(sim), ...[0, 1, 2].map((k) => w.spawnUnit('jeep', 0, { x: -30 + k * 30, z: 110 }, Math.PI))];
    run(sim, 50 * SIM_HZ, [{ player: 0, cmd: { type: 'holdLine', units: army.map((u) => u.id), points: [{ x: -90, z: 40 }, { x: 90, z: 40 }] } }]);
    const line = sim.lines(0)[0];
    expect(Math.abs(Math.abs(line.facing) - Math.PI)).toBeLessThan(0.1); // faces -z, away from the HQ
    const startSlots = new Map(army.map((u) => [u.id, { ...u.lineSlot! }]));
    sim.step([{ player: 0, cmd: { type: 'advanceLine', line: line.id, distance: 70 } }]);
    expect(sim.lines(0)[0].target).toBeTruthy();
    const arrived = new Map<number, number>();
    let maxDepthSpread = 0;
    for (let t = 1; t < 90 * SIM_HZ; t++) {
      sim.step([]);
      const front = army.filter((u) => u.armor === 'infantry');
      // How far each front unit has come: they stay level with each other (within a few meters).
      const progress = front.map((u) => startSlots.get(u.id)!.z - u.pos.z);
      maxDepthSpread = Math.max(maxDepthSpread, Math.max(...progress) - Math.min(...progress));
      for (const u of army) {
        const goal = startSlots.get(u.id)!;
        if (!arrived.has(u.id) && Math.hypot(u.pos.x - goal.x, u.pos.z - (goal.z - 70)) < 3.5) arrived.set(u.id, t);
      }
      if (arrived.size === army.length) break;
    }
    expect(arrived.size).toBe(army.length);
    const times = [...arrived.values()];
    // Jeeps (16 m/s) and riflemen (4 m/s) arrive within a few seconds of each other.
    expect((Math.max(...times) - Math.min(...times)) / SIM_HZ).toBeLessThan(4);
    expect(maxDepthSpread).toBeLessThan(12);
    expect(minGap(army)).toBeGreaterThan(-0.5);
  });

  it('contact halts the line where it is; it fights in place instead of piling in', () => {
    const sim = flat();
    const w = sim.world;
    const squad = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => w.spawnUnit('rifleman', 0, { x: -40 + k * 10, z: 90 }, Math.PI));
    run(sim, 30 * SIM_HZ, [{ player: 0, cmd: { type: 'holdLine', units: squad.map((u) => u.id), points: [{ x: -50, z: 40 }, { x: 50, z: 40 }] } }]);
    const line = sim.lines(0)[0];
    // An enemy position 140 m ahead, spotted by a scout.
    const enemy = [0, 1, 2].map((k) => w.spawnUnit('rifleman', 1, { x: -10 + k * 10, z: -100 }, 0));
    sim.step([{ player: 1, cmd: { type: 'hold', units: enemy.map((u) => u.id) } }]);
    sim.step([{ player: 0, cmd: { type: 'advanceLine', line: line.id, distance: 300 } }]);
    run(sim, 40 * SIM_HZ);
    const l = sim.lines(0)[0];
    expect(l.target).toBeNull();
    // Halted roughly at rifle range, not on top of the enemy.
    const zs = squad.filter((u) => !u.dead).map((u) => u.pos.z);
    expect(Math.min(...zs)).toBeGreaterThan(-100 + 30);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(12);
  });

  it('is deterministic through a march, a contact halt and a second advance', () => {
    const play = () => {
      const sim = flat();
      const army = mixedArmy(sim);
      const hashes: number[] = [];
      sim.step([{ player: 0, cmd: { type: 'holdLine', units: army.map((u) => u.id), points: [{ x: -90, z: 40 }, { x: 90, z: 40 }] } }]);
      for (let t = 0; t < 1600; t++) {
        const cmds: AnyPlayerCommand[] = [];
        if (t === 400) {
          sim.world.spawnUnit('tank_mbt', 1, { x: 0, z: -150 }, 0);
          cmds.push({ player: 0, cmd: { type: 'advanceLine', line: sim.lines(0)[0].id, distance: 250 } });
        }
        if (t === 1200 && sim.lines(0)[0]) cmds.push({ player: 0, cmd: { type: 'advanceLine', line: sim.lines(0)[0].id, distance: 40 } });
        sim.step(cmds);
        if (t % 50 === 0) hashes.push(sim.hash());
      }
      return hashes;
    };
    expect(play()).toEqual(play());
  }, 60000);
});
