import { describe, expect, it, vi } from 'vitest';
import { applySharedCommand } from '../src/net/lobby';
import type { PlayerSlot } from '../src/shared/types';
import { TestWorld } from './net-harness';

vi.setConfig({ testTimeout: 60_000 });

const human = (id: number, team: number): PlayerSlot => ({ id, team, name: `P${id}`, color: '#888888', kind: 'human' });

describe('shared command (lobby → setup)', () => {
  it('joins every later human of a team to the first one; AIs keep their own army', () => {
    const out = applySharedCommand([human(0, 0), { ...human(1, 1), kind: 'ai' }, human(2, 0), human(3, 1), human(4, 0)]);
    expect(out.map((p) => p.army)).toEqual([undefined, undefined, 0, undefined, 0]);
  });

  it('starts a co-op match: same setup on every peer, roles carried, both peers run it', async () => {
    const world = new TestWorld({ latencyMs: 25 });
    const host = await world.host('Alice');
    const bob = await world.join('Bob', host.lobby.code);
    await world.run(200);
    host.lobby.setSettings({ coop: true });
    bob.lobby.updateSelf({ team: 0, role: 'air' });
    host.lobby.updateSelf({ role: 'ground' });
    host.lobby.addAi('easy');
    await world.run(200);
    bob.lobby.setReady(true);
    await world.run(200);
    expect(host.lobby.canStart()).toEqual({ ok: true });
    const started = await host.lobby.start();
    await world.run(200);
    const players = started.setup.players;
    expect(players.map((p) => [p.name, p.army, p.role])).toEqual([
      ['Alice', undefined, 'ground'],
      ['Bob', 0, 'air'],
      ['AI (easy)', undefined, undefined],
    ]);
    expect(bob.lobby.match?.setup).toEqual(started.setup);
  });
});
