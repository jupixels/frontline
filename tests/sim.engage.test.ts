import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/shared/events';
import { SIM_HZ, type MatchSetup } from '../src/shared/types';
import type { AnyPlayerCommand } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import { flatContent, twoPlayers } from './fixtures';

function run(sim: Simulation, ticks: number, cmds: AnyPlayerCommand[] = []): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) out.push(...sim.step(t === 0 ? cmds : []));
  return out;
}

function flat(setup: MatchSetup = twoPlayers()): Simulation {
  const sim = new Simulation(setup, flatContent());
  for (const e of [...sim.world.entities.values()]) if (e.kind === 'unit') sim.world.remove(e.id);
  return sim;
}

describe('auto-engage', () => {
  it('a rifle squad on a plain move shoots an enemy in range without stopping', () => {
    const sim = flat();
    const w = sim.world;
    const squad = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: -60 + i * 2, z: 0 }, Math.PI / 2));
    // An (unarmed) enemy truck parked beside the route, 30 m off it.
    w.spawnUnit('supply_truck', 1, { x: 0, z: 30 }, 0);
    const ids = squad.map((u) => u.id);
    sim.step([{ player: 0, cmd: { type: 'move', units: ids, target: { x: 60, z: 0 } } }]);
    const ev: SimEvent[] = [];
    // Walk the route while the order lasts: they shoot, never stop or leave the road to chase.
    let ticks = 0;
    while (squad.some((u) => u.order?.kind === 'move') && ticks < 40 * SIM_HZ) {
      ev.push(...sim.step([]));
      ticks++;
      for (const u of squad) if (u.order?.kind === 'move') expect(Math.abs(u.pos.z)).toBeLessThan(6);
    }
    expect(ev.some((e) => e.type === 'fired' && ids.includes(e.id))).toBe(true);
    // 120 m at 4 m/s: no time lost to stopping.
    expect(ticks).toBeLessThan(33 * SIM_HZ);
  });

  it('attack-move still stops and fights', () => {
    const sim = flat();
    const w = sim.world;
    const squad = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: -60 + i * 2, z: 0 }, Math.PI / 2));
    const jeep = w.spawnUnit('jeep', 1, { x: 0, z: 30 }, 0);
    sim.step([{ player: 1, cmd: { type: 'hold', units: [jeep.id] } }]);
    run(sim, 8 * SIM_HZ, [{ player: 0, cmd: { type: 'move', units: squad.map((u) => u.id), target: { x: 60, z: 0 }, attackMove: true } }]);
    // Engaged the jeep instead of walking past it.
    expect(squad.some((u) => u.pos.x < 30 || u.dead) || jeep.dead).toBe(true);
  });

  it('an idle unit returns fire on an attacker it can see, even beyond its own reach', () => {
    const sim = flat();
    const w = sim.world;
    const tank = w.spawnUnit('tank_mbt', 0, { x: 0, z: 0 }, 0);
    // A sniper 105 m away out-ranges the tank's guns but a jeep spots it for the tank's side.
    const sniper = w.spawnUnit('sniper', 1, { x: 0, z: 105 }, Math.PI);
    w.spawnUnit('jeep', 0, { x: 0, z: 40 }, 0);
    sim.step([{ player: 1, cmd: { type: 'attack', units: [sniper.id], targetId: tank.id } }]);
    const ev = run(sim, 15 * SIM_HZ);
    expect(ev.some((e) => e.type === 'fired' && e.id === tank.id)).toBe(true);
  });
});

describe('engineers auto-build', () => {
  it('an idle engineer near an unfinished site starts building it, then the next one', () => {
    const sim = flat();
    const w = sim.world;
    const eng = w.spawnUnit('engineer', 0, { x: -150, z: 180 }, 0);
    const a = w.spawnStructure('power_plant', 0, { x: -130, z: 180 }, 0, false);
    const b = w.spawnStructure('trench', 0, { x: -150, z: 205 }, 0, false);
    run(sim, 12);
    expect(eng.order).toEqual({ kind: 'build', siteId: a.id });
    expect(sim.route(eng.id)?.legs[0].kind).toBe('build');
    run(sim, 60 * SIM_HZ);
    expect(a.buildProgress).toBe(1);
    expect(b.buildProgress).toBe(1);
    expect(eng.order).toBeNull();
  });

  it("doesn't hijack an engineer with orders, or touch far or enemy sites", () => {
    const sim = flat();
    const w = sim.world;
    const busy = w.spawnUnit('engineer', 0, { x: -150, z: 180 }, 0);
    const idle = w.spawnUnit('engineer', 0, { x: 100, z: -100 }, 0);
    w.spawnStructure('power_plant', 0, { x: -130, z: 180 }, 0, false);
    w.spawnStructure('power_plant', 1, { x: 100, z: -80 }, 0, false);
    w.spawnStructure('power_plant', 0, { x: 100, z: -40 }, 0, false);
    run(sim, 2 * SIM_HZ, [{ player: 0, cmd: { type: 'move', units: [busy.id], target: { x: -200, z: 120 } } }]);
    expect(busy.order?.kind).toBe('move');
    expect(idle.order).toBeNull();
  });

  it('helps a co-op partner build', () => {
    const setup: MatchSetup = { ...twoPlayers(), players: [0, 1].map((id) => ({ id, team: 0, name: `P${id}`, color: '#888', kind: 'human' as const, commandsFor: id === 1 ? [0] : undefined })) };
    const sim = flat(setup);
    const w = sim.world;
    const eng = w.spawnUnit('engineer', 1, { x: 0, z: 0 }, 0);
    const site = w.spawnStructure('power_plant', 0, { x: 20, z: 0 }, 0, false);
    run(sim, 12);
    expect(eng.order).toEqual({ kind: 'build', siteId: site.id });
  });
});
