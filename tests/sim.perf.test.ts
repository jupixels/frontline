import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { FlowField } from '../src/sim/path/flowfield';
import { testContent, twoPlayers } from './fixtures';

describe('sim performance', () => {
  it('builds a flow field quickly', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const nav = sim.world.nav;
    for (let i = 0; i < 20; i++) new FlowField(nav, 'ground', 5); // warm up the JIT
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) new FlowField(nav, 'ground', nav.cellOf({ x: i * 10 - 100, z: 50 }));
    const ms = (performance.now() - t1) / 20;
    console.log(`flow field ${nav.cols}x${nav.rows}: ${ms.toFixed(2)} ms`);
    // Generous: the suite runs files in parallel, which slows this down a lot.
    expect(ms).toBeLessThan(40);
  });

  it('steps 300+ fighting units within budget', () => {
    const sim = new Simulation(twoPlayers(), testContent());
    const w = sim.world;
    // 160 units per side in blocks facing each other across the center.
    const types = ['rifleman', 'rifleman', 'at_soldier', 'tank_mbt', 'ifv', 'jeep', 'artillery', 'heli_attack'];
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < 160; i++) {
        const x = (i % 16) * 6 - 45;
        const z = (side === 0 ? 1 : -1) * (90 + Math.floor(i / 16) * 6);
        w.spawnUnit(types[i % types.length], side, { x, z }, side === 0 ? Math.PI : 0);
      }
    }
    const ids = (p: number) => [...sim.entities()].filter((e) => e.owner === p && e.kind === 'unit').map((e) => e.id);
    sim.step([
      { player: 0, cmd: { type: 'move', units: ids(0), target: { x: 0, z: -60 }, attackMove: true } },
      { player: 1, cmd: { type: 'move', units: ids(1), target: { x: 0, z: 60 }, attackMove: true } },
    ]);
    const t0 = performance.now();
    const ticks = 200;
    let deaths = 0;
    for (let t = 0; t < ticks; t++) deaths += sim.step([]).filter((e) => e.type === 'died').length;
    const ms = (performance.now() - t0) / ticks;
    console.log(`${ids(0).length + ids(1).length} units left, ${deaths} died, ${ms.toFixed(2)} ms/tick`);
    expect(deaths).toBeGreaterThan(10);
    // The real budget is one 50 ms tick (20 Hz); alone this runs at ~6 ms.
    expect(ms).toBeLessThan(50);
  });
});
