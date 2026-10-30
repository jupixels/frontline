import { describe, expect, it } from 'vitest';
import { parseReplay, ReplaySession, serializeReplay } from '../src/net/replay';
import { Simulation } from '../src/sim/simulation';
import { testContent } from './fixtures';
import { TestWorld } from './net-harness';

describe('replays', () => {
  it('a saved command log replays to identical state', async () => {
    const world = new TestWorld({ latencyMs: 30, jitterMs: 20, ordered: false });
    const host = await world.host('H');
    const b = await world.join('B', host.lobby.code);
    await world.run(100);
    b.lobby.setReady(true);
    host.lobby.addAi('easy');
    await world.run(100);
    await host.lobby.start();
    await world.run(20_000);

    const log = b.session!.commandLog();
    expect(log.turns.length).toBeGreaterThan(10);
    expect(log.hashes.length).toBeGreaterThan(5);
    const file = parseReplay(serializeReplay(log));
    const replay = new ReplaySession(file);
    const sim = new Simulation(file.setup, testContent());
    let checked = 0;
    for (;;) {
      const turn = replay.pollTurn(sim.tick);
      if (!turn) break;
      sim.step(turn.commands);
      if (sim.tick % 50 === 0) {
        replay.reportHash(sim.tick, sim.hash());
        if (b.hashes.has(sim.tick)) {
          expect(sim.hash()).toBe(b.hashes.get(sim.tick));
          checked++;
        }
      }
    }
    expect(sim.tick).toBe(file.endTick);
    expect(replay.mismatch).toBeNull();
    expect(checked).toBeGreaterThan(5);
  });

  it('rejects files that are not replays', () => {
    expect(() => parseReplay('nope')).toThrow(/invalid JSON/);
    expect(() => parseReplay('{"format":"x"}')).toThrow(/Not a Frontline replay/);
    expect(() => parseReplay('{"format":"frontline-replay","version":9}')).toThrow(/version 9/);
  });
});
