import { describe, expect, it } from 'vitest';
import type { CommandRole, MatchSetup } from '../src/shared/types';
import { SIM_HZ } from '../src/shared/types';
import type { AnyPlayerCommand } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import { setupFor, testContent } from './fixtures';

// Shared-command co-op: players 0 and 1 are one army (1 joins 0's), player 2 is the enemy.
function coop(roles?: [CommandRole | undefined, CommandRole | undefined]): MatchSetup {
  const s = setupFor([0, 0, 1]);
  s.players[1].army = 0;
  if (roles) {
    s.players[0].role = roles[0];
    s.players[1].role = roles[1];
  }
  return s;
}

function run(sim: Simulation, ticks: number, cmds: AnyPlayerCommand[] = []): void {
  for (let t = 0; t < ticks; t++) sim.step(t === 0 ? cmds : []);
}

const owned = (sim: Simulation, owner: number, type: string) => [...sim.world.entities.values()].find((e) => e.owner === owner && e.type === type)!;

describe('shared-command co-op', () => {
  it('a co-commander starts with no army of its own and is not defeated for it', () => {
    const sim = new Simulation(coop(), testContent());
    expect([...sim.world.entities.values()].filter((e) => e.owner === 1)).toHaveLength(0);
    run(sim, 3 * SIM_HZ);
    expect(sim.world.players.get(1)!.defeated).toBe(false);
    expect(sim.canCommand(1, owned(sim, 0, 'hq').id)).toBe(true);
  });

  it('both commanders order the same army and spend one economy', () => {
    const sim = new Simulation(coop(), testContent());
    const w = sim.world;
    const rifle = owned(sim, 0, 'rifleman');
    const hq = owned(sim, 0, 'hq');
    const start = { ...rifle.pos };
    const s0 = w.players.get(0)!.supply;
    run(sim, 4 * SIM_HZ, [
      { player: 1, cmd: { type: 'move', units: [rifle.id], target: { x: 0, z: 0 } } },
      { player: 1, cmd: { type: 'produce', factory: hq.id, unit: 'engineer', count: 1 } },
    ]);
    expect(Math.hypot(rifle.pos.x - start.x, rifle.pos.z - start.z)).toBeGreaterThan(5);
    expect(w.players.get(0)!.supply).toBeLessThan(s0);
    expect(sim.queue(hq.id).length).toBeGreaterThan(0);
  });

  it('roles split the army; a role nobody holds stays open', () => {
    const sim = new Simulation(coop(['logistics', 'ground']), testContent());
    const rifle = owned(sim, 0, 'rifleman');
    const eng = owned(sim, 0, 'engineer');
    const hq = owned(sim, 0, 'hq');
    // Ground commands the infantry, logistics the engineers and the HQ.
    expect(sim.canCommand(1, rifle.id)).toBe(true);
    expect(sim.canCommand(0, rifle.id)).toBe(false);
    expect(sim.canCommand(0, eng.id)).toBe(true);
    expect(sim.canCommand(1, eng.id)).toBe(false);
    expect(sim.canCommand(0, hq.id)).toBe(true);
    expect(sim.canCommand(1, hq.id)).toBe(false);
    // Air and navy are unassigned: anyone on the army may use them.
    const heli = sim.world.spawnUnit('heli_attack', 0, { x: 0, z: 0 }, 0, 0);
    expect(sim.canCommand(0, heli.id)).toBe(true);
    expect(sim.canCommand(1, heli.id)).toBe(true);
    // An order outside the role is ignored.
    const start = { ...rifle.pos };
    run(sim, 3 * SIM_HZ, [{ player: 0, cmd: { type: 'move', units: [rifle.id], target: { x: 0, z: 0 } } }]);
    expect(rifle.pos).toEqual(start);
  });

  it('the co-commander falls with the army', () => {
    const sim = new Simulation(coop(), testContent());
    run(sim, 2, [{ player: 0, cmd: { type: 'surrender' } }]);
    expect(sim.world.players.get(0)!.defeated).toBe(true);
    expect(sim.world.players.get(1)!.defeated).toBe(true);
    expect(sim.winner).toBe(1);
  });

  it('a co-commander cannot join an enemy or another co-commander', () => {
    const s = setupFor([0, 0, 1, 1]);
    s.players[1].army = 2; // enemy team
    s.players[3].army = 2;
    s.players[2].army = 0; // enemy team as well
    const sim = new Simulation(s, testContent());
    expect(sim.world.armyOf.has(1)).toBe(false);
    expect(sim.world.armyOf.has(2)).toBe(false);
    // 2 is set up as a co-commander itself, so nobody may join it.
    expect(sim.world.armyOf.has(3)).toBe(false);
    expect([...sim.world.entities.values()].some((e) => e.owner === 3 && e.type === 'hq')).toBe(true);
  });

  it('is deterministic with co-commanders issuing orders', () => {
    const play = () => {
      const sim = new Simulation(coop(['ground', 'logistics']), testContent());
      const rifle = owned(sim, 0, 'rifleman');
      const eng = owned(sim, 0, 'engineer');
      run(sim, 20 * SIM_HZ, [
        { player: 0, cmd: { type: 'move', units: [rifle.id], target: { x: 30, z: -20 } } },
        { player: 1, cmd: { type: 'build', builder: eng.id, structure: 'barracks', at: { x: eng.pos.x + 30, z: eng.pos.z }, rotation: 0 } },
      ]);
      return sim.hash();
    };
    expect(play()).toBe(play());
  });
});
