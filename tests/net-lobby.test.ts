import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/net/protocol';
import { makeRoomCode, normalizeRoomCode, roomCodeFromUrl, shareUrl } from '../src/net/lobby';
import { TestWorld } from './net-harness';

describe('room codes', () => {
  it('generates 6-char unambiguous codes and parses share links', () => {
    const code = makeRoomCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(normalizeRoomCode(` ${code.toLowerCase()} `)).toBe(code);
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCDE0')).toBeNull();
    const url = shareUrl(code, 'https://jupixels.github.io/frontline/');
    expect(url).toBe(`https://jupixels.github.io/frontline/#room=${code}`);
    expect(roomCodeFromUrl(url)).toBe(code);
    expect(roomCodeFromUrl('https://x/#foo')).toBeNull();
  });
});

describe('lobby', () => {
  it('fills slots, syncs settings, chat and ready, and starts with one seed everywhere', async () => {
    const world = new TestWorld({ latencyMs: 25 });
    const host = await world.host('Alice', { baseUrl: 'https://example.test/' });
    expect(host.lobby.isHost).toBe(true);
    expect(host.lobby.url).toBe(`https://example.test/#room=${host.lobby.code}`);
    const bob = await world.join('Bob', host.lobby.code);
    const cat = await world.join('Cat', host.lobby.code);
    await world.run(200);

    expect(bob.lobby.isHost).toBe(false);
    expect(bob.lobby.slots.filter((s) => s.state === 'human').map((s) => s.name)).toEqual(['Alice', 'Bob', 'Cat']);
    expect(bob.lobby.localSlot?.index).toBe(1);

    const chats: ChatMessage[] = [];
    cat.lobby.on('chat', (m) => chats.push(m));
    bob.lobby.sendChat('  gl hf  ');
    bob.lobby.updateSelf({ team: 0, color: '#4f8fe6' }); // the host's color: refused
    host.lobby.setSettings({ victory: 'annihilation', maxPlayers: 4 });
    await world.run(200);
    expect(chats).toContainEqual({ slot: 1, name: 'Bob', text: 'gl hf' });
    expect(cat.lobby.settings).toMatchObject({ victory: 'annihilation', maxPlayers: 4 });
    expect(cat.lobby.slots.length).toBe(4);
    expect(cat.lobby.slots[1].team).toBe(0);
    expect(cat.lobby.slots[1].color).not.toBe('#4f8fe6');

    expect(host.lobby.canStart()).toEqual({ ok: false, reason: 'not-ready' });
    bob.lobby.setReady(true);
    cat.lobby.setReady(true);
    host.lobby.addAi('hard');
    await world.run(200);
    expect(cat.lobby.slots[3]).toMatchObject({ state: 'ai', aiDifficulty: 'hard', ready: true });
    expect(bob.lobby.canStart().reason).toBe('not-host');
    expect(host.lobby.canStart()).toEqual({ ok: true });

    const started = await host.lobby.start();
    await world.run(200);
    for (const p of [host, bob, cat]) {
      expect(p.lobby.match?.setup).toEqual(started.setup);
      expect(p.lobby.snapshot.phase).toBe('inGame');
    }
    expect(started.setup.victory).toBe('annihilation');
    expect(started.setup.players.map((p) => [p.id, p.name, p.kind, p.team])).toEqual([
      [0, 'Alice', 'human', 0],
      [1, 'Bob', 'human', 0],
      [2, 'Cat', 'human', 2],
      [3, 'AI (hard)', 'ai', 3],
    ]);
    expect(bob.session!.localPlayer).toBe(1);
    expect(cat.session!.localPlayer).toBe(2);
    // Joining a running game without a ticket is refused.
    await expect(world.join('Late', host.lobby.code)).rejects.toMatchObject({ code: 'rejected', reason: 'in-progress' });
  });

  it('rejects when full and when the host kicked you', async () => {
    const world = new TestWorld();
    const host = await world.host('H', { settings: { maxPlayers: 2 } });
    const a = await world.join('A', host.lobby.code);
    await expect(world.join('B', host.lobby.code)).rejects.toMatchObject({ code: 'rejected', reason: 'full' });

    let closedWith = '';
    a.lobby.on('closed', (e) => (closedWith = e.code));
    host.lobby.kick(a.lobby.localSlot!.index);
    await world.run(200);
    expect(closedWith).toBe('kicked');
    expect(host.lobby.slots[1].state).toBe('open');
  });

  it('migrates the host when the host leaves the lobby', async () => {
    const world = new TestWorld();
    const host = await world.host('H');
    const a = await world.join('A', host.lobby.code);
    const b = await world.join('B', host.lobby.code);
    await world.run(100);
    host.lobby.leave();
    world.peers.splice(0, 1);
    await world.run(300);
    expect(a.lobby.isHost).toBe(true);
    expect(b.lobby.snapshot.hostPeer).toBe(a.lobby.selfId);
    expect(b.lobby.slots.filter((s) => s.state === 'human').map((s) => s.name)).toEqual(['A', 'B']);
    b.lobby.setReady(true);
    await world.run(100);
    expect(a.lobby.canStart()).toEqual({ ok: true });
  });

  it('times out with host-unreachable when nobody answers', async () => {
    const world = new TestWorld();
    await expect(world.join('Lonely', 'ABCDEF', { joinTimeoutMs: 3000 })).rejects.toMatchObject({ code: 'host-unreachable' });
  });
});
