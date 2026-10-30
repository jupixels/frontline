import { describe, expect, it } from 'vitest';
import structures from '../data/structures.json';
import type { SimEvent } from '../src/shared/events';
import { SIM_HZ, type MatchSetup } from '../src/shared/types';
import type { AnyPlayerCommand } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import { DEMOLISH_SECONDS } from '../src/sim/systems/demolish';
import { flatContent, twoPlayers } from './fixtures';

const COST = structures as unknown as Record<string, { cost: number }>;

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

const hqOf = (sim: Simulation, p: number) => [...sim.world.entities.values()].find((e) => e.type === 'hq' && e.owner === p)!;

describe('demolish', () => {
  it('cancels an unfinished site at once with a full refund', () => {
    const sim = flat();
    const w = sim.world;
    const p = w.players.get(0)!;
    const site = w.spawnStructure('barracks', 0, { x: -150, z: 180 }, 0, false);
    site.buildProgress = 0.4;
    const before = p.supply;
    const ev = run(sim, 1, [{ player: 0, cmd: { type: 'demolish', structures: [site.id] } }]);
    expect(w.entities.has(site.id)).toBe(false);
    expect(ev.some((e) => e.type === 'died')).toBe(false);
    // Full refund (plus one tick of HQ income).
    expect(p.supply - before).toBeGreaterThanOrEqual(COST.barracks.cost);
    expect(p.supply - before).toBeLessThan(COST.barracks.cost + 1);
  });

  it('a finished building comes down after the countdown for half its cost, without a loss', () => {
    const sim = flat();
    const w = sim.world;
    const p = w.players.get(0)!;
    const plant = w.spawnStructure('power_plant', 0, { x: -150, z: 180 }, 0, true);
    const morale = w.teams.get(0)!.morale;
    let ev = run(sim, 1, [{ player: 0, cmd: { type: 'demolish', structures: [plant.id] } }]);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'demolish', id: plant.id, state: 'started' }));
    expect(plant.demolishAt).toBe(w.tick - 1 + DEMOLISH_SECONDS * SIM_HZ);
    run(sim, DEMOLISH_SECONDS * SIM_HZ - 2);
    expect(w.entities.has(plant.id)).toBe(true);
    const before = p.supply;
    ev = run(sim, 2);
    expect(w.entities.has(plant.id)).toBe(false);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'demolish', id: plant.id, state: 'done', refund: COST.power_plant.cost / 2 }));
    expect(ev.some((e) => e.type === 'died')).toBe(false);
    expect(p.supply - before).toBeGreaterThanOrEqual(COST.power_plant.cost / 2);
    expect(w.teams.get(0)!.morale).toBe(morale);
    // Power updates with it gone.
    run(sim, 1);
    expect(p.powerProduced).toBe((structures as unknown as Record<string, { power: number }>).hq.power);
  });

  it('ordering it again cancels the countdown', () => {
    const sim = flat();
    const w = sim.world;
    const plant = w.spawnStructure('power_plant', 0, { x: -150, z: 180 }, 0, true);
    run(sim, 20, [{ player: 0, cmd: { type: 'demolish', structures: [plant.id] } }]);
    const ev = run(sim, 1, [{ player: 0, cmd: { type: 'demolish', structures: [plant.id] } }]);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'demolish', state: 'cancelled' }));
    run(sim, DEMOLISH_SECONDS * SIM_HZ * 2);
    expect(w.entities.has(plant.id)).toBe(true);
    expect(plant.demolishAt).toBe(0);
  });

  it("refuses the HQ, and nobody can demolish an enemy's building", () => {
    const sim = flat();
    const w = sim.world;
    const hq = hqOf(sim, 0);
    const enemy = w.spawnStructure('power_plant', 1, { x: 150, z: -180 }, 0, true);
    const ev = run(sim, DEMOLISH_SECONDS * SIM_HZ + 5, [
      { player: 0, cmd: { type: 'demolish', structures: [hq.id] } },
      { player: 0, cmd: { type: 'demolish', structures: [enemy.id] } },
    ]);
    expect(ev).toContainEqual({ type: 'blocked', player: 0, reason: 'demolishHq' });
    expect(w.entities.has(hq.id)).toBe(true);
    expect(w.entities.has(enemy.id)).toBe(true);
    expect(enemy.demolishAt).toBe(0);
  });

  it('ejects the garrison and refunds the production queue', () => {
    const sim = flat();
    const w = sim.world;
    const p = w.players.get(0)!;
    const trench = w.spawnStructure('trench', 0, { x: -100, z: 150 }, 0, true);
    const squad = [0, 1, 2, 3].map((i) => w.spawnUnit('rifleman', 0, { x: -100 + i * 2, z: 160 }, 0));
    run(sim, 5 * SIM_HZ, [{ player: 0, cmd: { type: 'enter', units: squad.map((u) => u.id), target: trench.id } }]);
    expect(trench.cargo).toHaveLength(4);
    const rax = w.spawnStructure('barracks', 0, { x: -160, z: 120 }, 0, true);
    p.supply = 1000;
    run(sim, 1, [{ player: 0, cmd: { type: 'produce', factory: rax.id, unit: 'rifleman', count: 3 } }]);
    const queued = rax.queue.reduce((n, q) => n + q.paid, 0);
    expect(queued).toBeGreaterThan(0);
    const before = p.supply;
    run(sim, DEMOLISH_SECONDS * SIM_HZ + 2, [{ player: 0, cmd: { type: 'demolish', structures: [trench.id, rax.id] } }]);
    expect(w.entities.has(trench.id)).toBe(false);
    expect(w.entities.has(rax.id)).toBe(false);
    for (const u of squad) {
      expect(u.dead).toBe(false);
      expect(u.inside).toBe(0);
    }
    expect(p.supply - before).toBeGreaterThanOrEqual(queued + COST.barracks.cost / 2 + Math.floor(COST.trench.cost / 2));
  });

  it('co-op: a logistics co-commander may demolish; a ground co-commander may not when logistics is held', () => {
    const setup: MatchSetup = {
      ...twoPlayers(),
      players: [
        { id: 0, team: 0, name: 'A', color: '#888', kind: 'human' },
        { id: 1, team: 0, name: 'B', color: '#888', kind: 'human', army: 0, role: 'ground' },
        { id: 2, team: 0, name: 'C', color: '#888', kind: 'human', army: 0, role: 'logistics' },
        { id: 3, team: 1, name: 'D', color: '#888', kind: 'human' },
      ],
    };
    const sim = flat(setup);
    const w = sim.world;
    const a = w.spawnStructure('power_plant', 0, { x: -150, z: 180 }, 0, true);
    const b = w.spawnStructure('power_plant', 0, { x: -120, z: 180 }, 0, true);
    run(sim, 1, [
      { player: 1, cmd: { type: 'demolish', structures: [a.id] } },
      { player: 2, cmd: { type: 'demolish', structures: [b.id] } },
    ]);
    expect(a.demolishAt).toBe(0);
    expect(b.demolishAt).toBeGreaterThan(0);
  });

  it('is deterministic with demolitions in the command stream', () => {
    const play = () => {
      const sim = flat();
      const w = sim.world;
      const plants = [0, 1, 2].map((i) => w.spawnStructure('power_plant', 0, { x: -160 + i * 18, z: 160 }, 0, true));
      const site = w.spawnStructure('barracks', 0, { x: -120, z: 120 }, 0, false);
      const hashes: number[] = [];
      for (let t = 0; t < 400; t++) {
        const cmds: AnyPlayerCommand[] = [];
        if (t === 5) cmds.push({ player: 0, cmd: { type: 'demolish', structures: [plants[0].id, site.id] } });
        if (t === 30) cmds.push({ player: 0, cmd: { type: 'demolish', structures: [plants[1].id] } });
        if (t === 60) cmds.push({ player: 0, cmd: { type: 'demolish', structures: [plants[1].id, plants[2].id] } });
        sim.step(cmds);
        if (t % 20 === 0) hashes.push(sim.hash());
      }
      return { hashes, left: [...w.entities.values()].filter((e) => e.type === 'power_plant').length };
    };
    const a = play();
    expect(play()).toEqual(a);
    expect(a.left).toBe(1);
  });
});
