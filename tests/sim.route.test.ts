import { describe, expect, it } from 'vitest';
import type { AnyPlayerCommand } from '../src/sim/contracts';
import { Simulation } from '../src/sim/simulation';
import { setupFor, testContent } from './fixtures';

const owned = (sim: Simulation, owner: number, type: string) => [...sim.world.entities.values()].find((e) => e.owner === owner && e.type === type)!;

function run(sim: Simulation, ticks: number, cmds: AnyPlayerCommand[] = []): void {
  for (let t = 0; t < ticks; t++) sim.step(t === 0 ? cmds : []);
}

describe('unit routes (path lines)', () => {
  it('reports current and queued legs, ending the traced path at the goal', () => {
    const sim = new Simulation(setupFor([0, 1]), testContent());
    const rifle = owned(sim, 0, 'rifleman');
    expect(sim.route(rifle.id)).toBeNull();
    run(sim, 2, [
      { player: 0, cmd: { type: 'move', units: [rifle.id], target: { x: 0, z: 0 } } },
      { player: 0, cmd: { type: 'move', units: [rifle.id], target: { x: 20, z: 10 }, attackMove: true, queue: true } },
    ]);
    const r = sim.route(rifle.id)!;
    expect(r.legs.map((l) => l.kind)).toEqual(['move', 'attackMove']);
    expect(r.path.at(-1)).toEqual(r.legs[0].to);
    expect(Math.hypot(r.legs[0].to.x, r.legs[0].to.z)).toBeLessThan(3);
    expect(sim.route(rifle.id, false)!.path).toHaveLength(1);
  });

  it('patrols list both ends, and reading routes never changes the state', () => {
    const a = new Simulation(setupFor([0, 1]), testContent());
    const b = new Simulation(setupFor([0, 1]), testContent());
    const cmd = (sim: Simulation): AnyPlayerCommand => ({ player: 0, cmd: { type: 'patrol', units: [owned(sim, 0, 'rifleman').id], target: { x: 30, z: 0 } } });
    const ca = [cmd(a)];
    const cb = [cmd(b)];
    for (let t = 0; t < 120; t++) {
      a.step(t === 0 ? ca : []);
      b.step(t === 0 ? cb : []);
      for (const e of a.world.entities.values()) a.route(e.id);
    }
    expect(a.hash()).toBe(b.hash());
    const r = a.route(owned(a, 0, 'rifleman').id)!;
    expect(r.legs.map((l) => l.kind)).toEqual(['patrol', 'patrol']);
  });
});
