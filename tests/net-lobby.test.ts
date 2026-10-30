import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/net/protocol';
import { makeRoomCode, normalizeRoomCode, roomCodeFromUrl, shareUrl } from '../src/net/lobby';
import { TestWorld } from './net-harness';

// Several full sims run per test; the sim got heavier than vitest's 5 s default allows.
vi.setConfig({ testTimeout: 60_000 });

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

  it('sizes the room to the map: closes extra slots, moves players down, refuses when too many are seated', async () => {
    const world = new TestWorld();
    const host = await world.host('H', { settings: { maxPlayers: 2 } });
    expect(host.lobby.slots.length).toBe(2);
    // An 8-player map opens all eight.
    expect(host.lobby.setSettings({ mapId: 'inland_sea', maxPlayers: 8 })).toBe(true);
    const a = await world.join('A', host.lobby.code);
    await world.run(100);
    expect(a.lobby.slots.length).toBe(8);
    expect(a.lobby.slots.filter((s) => s.state === 'open')).toHaveLength(6);
    a.lobby.moveToSlot(6);
    host.lobby.addAi('hard', 7);
    await world.run(100);
    expect(host.lobby.slots[6].name).toBe('A');
    // Down to a 4-player map: A and the AI move into free slots below 4.
    expect(host.lobby.setSettings({ mapId: 'desert_oilfields', maxPlayers: 4 })).toBe(true);
    await world.run(100);
    expect(a.lobby.slots.length).toBe(4);
    expect(a.lobby.localSlot!.index).toBeLessThan(4);
    expect(a.lobby.slots.filter((s) => s.state === 'ai')).toHaveLength(1);
    expect(host.lobby.snapshot.slots.slice(4).every((s) => s.state === 'closed')).toBe(true);
    // A 2-player map can't seat three: refused, nothing changes.
    expect(host.lobby.setSettings({ mapId: 'valley_pass', maxPlayers: 2 })).toBe(false);
    expect(host.lobby.settings).toMatchObject({ mapId: 'desert_oilfields', maxPlayers: 4 });
    // Back up to 8: the closed slots open again.
    expect(host.lobby.setSettings({ mapId: 'inland_sea', maxPlayers: 8 })).toBe(true);
    expect(host.lobby.slots.filter((s) => s.state === 'open')).toHaveLength(5);
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

  it('moves players between slots, lets the host edit humans, and publishes pings', async () => {
    const world = new TestWorld({ latencyMs: 40 });
    const host = await world.host('H');
    const a = await world.join('A', host.lobby.code);
    const b = await world.join('B', host.lobby.code);
    await world.run(200);
    a.lobby.setReady(true);
    await world.run(100);

    // A moves from slot 1 to slot 5: keeps its name, loses ready; slot 1 opens up.
    a.lobby.moveToSlot(5);
    // B tries to take an occupied slot (the host's): ignored.
    b.lobby.moveToSlot(0);
    await world.run(200);
    expect(b.lobby.slots[5]).toMatchObject({ state: 'human', name: 'A', peer: a.lobby.selfId, ready: false });
    expect(b.lobby.slots[1].state).toBe('open');
    expect(b.lobby.slots[0].name).toBe('H');
    expect(b.lobby.localSlot?.index).toBe(2);
    expect(a.lobby.localSlot?.index).toBe(5);

    // Host moves itself too and stays ready.
    host.lobby.moveToSlot(7);
    await world.run(200);
    expect(a.lobby.slots[7]).toMatchObject({ name: 'H', ready: true });

    // Host edits another human's team and color; a taken color is refused.
    host.lobby.setPlayerSlot(5, { team: 3, color: '#123456' });
    host.lobby.setPlayerSlot(2, { color: '#123456' });
    a.lobby.setPlayerSlot(2, { team: 6 }); // not host: ignored
    await world.run(200);
    expect(b.lobby.slots[5]).toMatchObject({ team: 3, color: '#123456', name: 'A' });
    expect(b.lobby.slots[2].color).not.toBe('#123456');
    expect(b.lobby.slots[2].team).not.toBe(6);

    // Pings: host-measured RTT (~2 x 40 ms) shows up in every peer's copy of the slots.
    await world.run(5000);
    for (const p of [host, a, b]) {
      expect(p.lobby.slots[5].pingMs).toBeGreaterThanOrEqual(75);
      expect(p.lobby.slots[5].pingMs).toBeLessThan(120);
      expect(p.lobby.slots[2].pingMs).toBeGreaterThanOrEqual(75);
      expect(p.lobby.slots[7].pingMs).toBeUndefined(); // the host itself
    }

    // Start still assigns ids in slot order: B (slot 2) = 0, A (slot 5) = 1, H (slot 7) = 2.
    b.lobby.setReady(true);
    a.lobby.setReady(true);
    await world.run(200);
    const { setup } = await host.lobby.start();
    expect(setup.players.map((p) => p.name)).toEqual(['B', 'A', 'H']);
    expect(setup.players[1].team).toBe(3);
  });

  it('times out with host-unreachable when nobody answers', async () => {
    const world = new TestWorld();
    await expect(world.join('Lonely', 'ABCDEF', { joinTimeoutMs: 3000 })).rejects.toMatchObject({ code: 'host-unreachable' });
  });
});
